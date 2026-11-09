/**
 * Public contracts of the vehicle behavior domain (#835).
 *
 * This package answers one question: *what does the vehicle want, and when?*
 * It knows nothing of OCPP, connectors, transports, React or the scenario
 * runtime, and it reads no clock of its own: every function takes the instant
 * it is evaluated at, so the same inputs always give the same output. The
 * simulator adapts its demand to protocol effects (a suspended charge is
 * `SuspendedEV` on OCPP 1.6 and a charging-state change on 2.x); that
 * translation lives in the adapter, never here.
 *
 * Time is epoch milliseconds, power is watts, energy is watt-hours and a
 * state of charge is a percentage (0-100).
 */

/** What the vehicle can do technically. The charging curve and the electrical
 *  model stay with the host (#327): demand is capped by `maxPowerW` and the
 *  host's operating point applies the curve. */
export interface VehicleProfile {
  /** The vehicle's own charging ceiling in watts; omitted when unknown. */
  readonly maxPowerW?: number;
  /** Usable battery capacity in watt-hours; omitted when unknown. */
  readonly batteryCapacityWh?: number;
}

/** What the driver wants out of one session. Every field is optional; with
 *  none, the session has no objective and never completes by itself. */
export interface ChargingIntent {
  /** Stop asking for energy at this SoC (%). */
  readonly targetSoc?: number;
  /** Stop asking once this much energy was delivered in the session (Wh). */
  readonly requestedEnergyWh?: number;
  /** Epoch ms the driver leaves. An objective still open then is unmet. */
  readonly departureAt?: number;
}

/** A daily window in minutes after midnight, `[startMinute, endMinute)`.
 *  `endMinute <= startMinute` wraps over midnight (22:00-07:00 is 1320, 420). */
export interface DailyWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** One step of a {@link DemandStepsPolicy}. */
export interface DemandStep {
  /** Time after the session start the step applies from (ms). */
  readonly afterMs: number;
  /** The ceiling the vehicle puts on its own demand (W); `null` lifts it. */
  readonly maxPowerW: number | null;
}

/** An EV-initiated pause of a {@link ManualSuspendPolicy}. */
export interface EvPause {
  readonly afterMs: number;
  readonly durationMs: number;
}

export interface ImmediatePolicy {
  readonly type: "immediate";
}
export interface DelayedPolicy {
  readonly type: "delayed";
  /** Time after the session start before the vehicle asks for energy (ms). */
  readonly delayMs: number;
}
export interface TargetSocPolicy {
  readonly type: "target-soc";
}
export interface ScheduledWindowPolicy {
  readonly type: "scheduled-window";
  readonly windows: readonly DailyWindow[];
  /** Offset of the window clock from UTC in minutes; default 0. */
  readonly utcOffsetMinutes?: number;
}
export interface ManualSuspendPolicy {
  readonly type: "manual-suspend";
  readonly pauses: readonly EvPause[];
}
export interface DemandStepsPolicy {
  readonly type: "demand-steps";
  readonly steps: readonly DemandStep[];
}

/**
 * When the vehicle asks for energy.
 *
 * - `immediate`: from the plug-in on, and it never completes by itself (the
 *   intent is reported, not acted on).
 * - `target-soc`: immediately, until the intent's objective is met.
 * - `delayed`, `scheduled-window`, `manual-suspend`, `demand-steps`: the
 *   named gate on top of `target-soc`, so an objective still ends the demand.
 */
export type VehicleBehaviorPolicy =
  | ImmediatePolicy
  | DelayedPolicy
  | TargetSocPolicy
  | ScheduledWindowPolicy
  | ManualSuspendPolicy
  | DemandStepsPolicy;

/** The vehicle's state during a session. */
export type VehiclePhase =
  | "waiting" // connected, not asking yet (delay, window, not started)
  | "charging" // asking for energy
  | "suspended" // EV-initiated pause
  | "complete" // the objective is met
  | "departed"; // the departure time passed

/** What the vehicle outputs. Independent of any protocol's terminology. */
export interface VehicleDemand {
  /** Power the vehicle asks for in watts. `Infinity` means no limit of its
   *  own (the profile ceiling is unknown); 0 while not ready. */
  readonly requestedPowerW: number;
  /** Whether the vehicle asks for energy at all. A connected vehicle that is
   *  not ready is still connected. */
  readonly readyToCharge: boolean;
  /** The vehicle wants the session ended (only with `stopWhenDone`). */
  readonly stopRequested: boolean;
  /** Why the demand is what it is, for diagnostics. */
  readonly reason?: string;
}

/** The state of the objective, observable apart from the demand. */
export interface ObjectiveStatus {
  readonly status: "none" | "pending" | "met" | "unmet";
  /** SoC points still missing (%), when the intent has a SoC target. */
  readonly remainingSoc?: number;
  /** Energy still missing (Wh), when the intent has an energy target. */
  readonly remainingWh?: number;
}

/** What the host tells the vehicle each time it asks. */
export interface VehicleObservation {
  /** SoC in percent; `null` when the host does not know it yet. */
  readonly soc: number | null;
  /** Energy delivered to the vehicle in this session (Wh). */
  readonly deliveredWh: number;
}

/** The explicit, serializable state of one session. */
export interface VehicleSessionState {
  /** When the vehicle connected (epoch ms). */
  readonly startedAt: number;
}

/** A session's behavior: configuration the host stores and can serialize. */
export interface VehicleBehaviorSpec {
  readonly policy: VehicleBehaviorPolicy;
  readonly intent?: ChargingIntent;
  /** Ask for the session to end once the objective is met or the departure
   *  time has passed. Default false: a target stops the demand, and the
   *  session (the transaction) goes on until someone ends it. */
  readonly stopWhenDone?: boolean;
}

/** Everything observable about a session at one instant. */
export interface VehicleSnapshot {
  readonly phase: VehiclePhase;
  readonly demand: VehicleDemand;
  readonly objective: ObjectiveStatus;
  /** Time since the session start (ms). */
  readonly elapsedMs: number;
}
