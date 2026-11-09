import type {
  ChargingIntent,
  DailyWindow,
  VehicleBehaviorPolicy,
  VehicleBehaviorSpec,
  VehicleDemand,
  VehicleObservation,
  VehiclePhase,
  VehicleProfile,
  VehicleSessionState,
  VehicleSnapshot,
  ObjectiveStatus,
} from "./contracts";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Start a session for a vehicle that connects at `at`. */
export function startVehicleSession(at: number): VehicleSessionState {
  return { startedAt: at };
}

/** Whether `minuteOfDay` falls in `window` (see {@link DailyWindow}). */
export function inDailyWindow(
  window: DailyWindow,
  minuteOfDay: number,
): boolean {
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return true;
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** The objective of `intent` against what the session has delivered. Met when
 *  any named criterion is reached; `departureAt` makes an open one `unmet`. */
export function objectiveOf(
  intent: ChargingIntent | undefined,
  observation: VehicleObservation,
  now: number,
): ObjectiveStatus {
  const targetSoc = intent?.targetSoc;
  const wantedWh = intent?.requestedEnergyWh;
  if (targetSoc === undefined && wantedWh === undefined) {
    return { status: "none" };
  }
  const socMet =
    targetSoc !== undefined &&
    observation.soc !== null &&
    observation.soc >= targetSoc;
  const energyMet =
    wantedWh !== undefined && observation.deliveredWh >= wantedWh;
  const remainingSoc =
    targetSoc !== undefined && observation.soc !== null
      ? Math.max(0, targetSoc - observation.soc)
      : undefined;
  const remainingWh =
    wantedWh !== undefined
      ? Math.max(0, wantedWh - observation.deliveredWh)
      : undefined;
  const remaining = {
    ...(remainingSoc !== undefined && { remainingSoc }),
    ...(remainingWh !== undefined && { remainingWh }),
  };
  if (socMet || energyMet) return { status: "met", ...remaining };
  const departed =
    intent?.departureAt !== undefined && now >= intent.departureAt;
  return { status: departed ? "unmet" : "pending", ...remaining };
}

interface Gate {
  readonly phase: Extract<VehiclePhase, "waiting" | "charging" | "suspended">;
  /** The vehicle's own ceiling in this gate (W), `Infinity` when none. */
  readonly limitW: number;
  readonly reason: string;
}

function gateOf(
  policy: VehicleBehaviorPolicy,
  elapsedMs: number,
  now: number,
): Gate {
  switch (policy.type) {
    case "immediate":
    case "target-soc":
      return { phase: "charging", limitW: Infinity, reason: policy.type };
    case "delayed":
      return elapsedMs >= policy.delayMs
        ? { phase: "charging", limitW: Infinity, reason: "delay-elapsed" }
        : { phase: "waiting", limitW: 0, reason: "delayed-start" };
    case "scheduled-window": {
      const offset = (policy.utcOffsetMinutes ?? 0) * MS_PER_MINUTE;
      const local = (((now + offset) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
      const minute = Math.floor(local / MS_PER_MINUTE);
      return policy.windows.some((w) => inDailyWindow(w, minute))
        ? { phase: "charging", limitW: Infinity, reason: "in-window" }
        : { phase: "waiting", limitW: 0, reason: "outside-window" };
    }
    case "manual-suspend": {
      const paused = policy.pauses.some(
        (p) => elapsedMs >= p.afterMs && elapsedMs < p.afterMs + p.durationMs,
      );
      return paused
        ? { phase: "suspended", limitW: 0, reason: "ev-suspended" }
        : { phase: "charging", limitW: Infinity, reason: "ev-resumed" };
    }
    case "demand-steps": {
      let limitW = Infinity;
      let applied = false;
      // The step with the latest `afterMs` not after now wins, whatever the
      // order the list was written in.
      let latest = -Infinity;
      for (const step of policy.steps) {
        if (step.afterMs <= elapsedMs && step.afterMs >= latest) {
          latest = step.afterMs;
          limitW = step.maxPowerW ?? Infinity;
          applied = true;
        }
      }
      return {
        phase: "charging",
        limitW,
        reason:
          applied && limitW !== Infinity ? "demand-reduced" : "full-demand",
      };
    }
  }
}

const NOT_READY = (reason: string, stopRequested = false): VehicleDemand => ({
  requestedPowerW: 0,
  readyToCharge: false,
  stopRequested,
  reason,
});

/**
 * Resolve what the vehicle wants at `now`. Pure: the same spec, profile,
 * state, observation and instant give the same snapshot, whoever asks and
 * however often.
 */
export function evaluateVehicleBehavior(
  spec: VehicleBehaviorSpec,
  profile: VehicleProfile,
  state: VehicleSessionState,
  observation: VehicleObservation,
  now: number,
): VehicleSnapshot {
  const elapsedMs = Math.max(0, now - state.startedAt);
  const objective = objectiveOf(spec.intent, observation, now);
  const stopWhenDone = spec.stopWhenDone === true;
  const finish = (
    phase: VehiclePhase,
    demand: VehicleDemand,
  ): VehicleSnapshot => ({
    phase,
    demand,
    objective,
    elapsedMs,
  });

  // The objective ends the demand for every policy but `immediate`, which
  // reports it and goes on asking.
  if (spec.policy.type !== "immediate") {
    if (objective.status === "met") {
      return finish("complete", NOT_READY("objective-met", stopWhenDone));
    }
    if (objective.status === "unmet") {
      return finish("departed", NOT_READY("departed-unmet", stopWhenDone));
    }
  }

  const gate = gateOf(spec.policy, elapsedMs, now);
  if (gate.phase !== "charging") {
    return finish(gate.phase, NOT_READY(gate.reason));
  }
  const ceilingW = profile.maxPowerW ?? Infinity;
  return finish("charging", {
    requestedPowerW: Math.min(ceilingW, gate.limitW),
    readyToCharge: true,
    stopRequested: false,
    reason: gate.reason,
  });
}

/** Why a resolved `spec` is not usable, or `null`. For JSON that enters the
 *  system; {@link vehicleBehaviorConfigProblem} checks a stored config. */
export function vehicleBehaviorSpecProblem(spec: unknown): string | null {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return "vehicleBehavior must be an object";
  }
  const { policy, intent, stopWhenDone } = spec as Record<string, unknown>;
  const num = (v: unknown, min: number): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= min;
  if (typeof policy !== "object" || policy === null) {
    return "vehicleBehavior.policy must be an object";
  }
  const p = policy as Record<string, unknown>;
  switch (p.type) {
    case "immediate":
    case "target-soc":
      break;
    case "delayed":
      if (!num(p.delayMs, 0)) return "delayed.delayMs must be >= 0";
      break;
    case "scheduled-window": {
      if (!Array.isArray(p.windows) || p.windows.length === 0) {
        return "scheduled-window.windows must be a non-empty array";
      }
      for (const w of p.windows as Array<Record<string, unknown>>) {
        const ok = (m: unknown) =>
          typeof m === "number" && Number.isInteger(m) && m >= 0 && m <= 1440;
        if (!ok(w?.startMinute) || !ok(w?.endMinute)) {
          return "window minutes must be integers in 0-1440";
        }
      }
      if (p.utcOffsetMinutes !== undefined && !num(p.utcOffsetMinutes, -1440)) {
        return "scheduled-window.utcOffsetMinutes must be a number";
      }
      break;
    }
    case "manual-suspend": {
      if (!Array.isArray(p.pauses))
        return "manual-suspend.pauses must be an array";
      for (const x of p.pauses as Array<Record<string, unknown>>) {
        if (!num(x?.afterMs, 0) || !num(x?.durationMs, 0)) {
          return "pause afterMs and durationMs must be >= 0";
        }
      }
      break;
    }
    case "demand-steps": {
      if (!Array.isArray(p.steps)) return "demand-steps.steps must be an array";
      for (const s of p.steps as Array<Record<string, unknown>>) {
        if (!num(s?.afterMs, 0)) return "step afterMs must be >= 0";
        if (s.maxPowerW !== null && !num(s.maxPowerW, 0)) {
          return "step maxPowerW must be >= 0 or null";
        }
      }
      break;
    }
    default:
      return `unknown vehicleBehavior policy type ${String(p.type)}`;
  }
  if (intent !== undefined) {
    if (typeof intent !== "object" || intent === null) {
      return "vehicleBehavior.intent must be an object";
    }
    const i = intent as Record<string, unknown>;
    if (
      i.targetSoc !== undefined &&
      !(num(i.targetSoc, 0) && i.targetSoc <= 100)
    ) {
      return "intent.targetSoc must be 0-100";
    }
    if (i.requestedEnergyWh !== undefined && !num(i.requestedEnergyWh, 0)) {
      return "intent.requestedEnergyWh must be >= 0";
    }
    if (i.departureAt !== undefined && !num(i.departureAt, 0)) {
      return "intent.departureAt must be epoch milliseconds";
    }
  }
  if (stopWhenDone !== undefined && typeof stopWhenDone !== "boolean") {
    return "vehicleBehavior.stopWhenDone must be a boolean";
  }
  return null;
}
