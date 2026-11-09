import { cyrb128, draw, xoshiro128ss } from "../../shared/SeededRng";
import type { IdTagDistribution } from "../auth/IdTagPool";
import type { EVSettings, EVSettingsPatch } from "./EVSettings";

/**
 * Background charging traffic for one connector (#300).
 *
 * "Run plausible traffic against this CSMS for an hour" was unexpressible:
 * scenarios are deterministic node graphs that terminate in a verdict (#179),
 * which is exactly what makes them good for conformance and bad for
 * open-ended load. A non-terminating random construct does not belong inside
 * the thing whose value is that it terminates with an answer.
 *
 * So this is a per-connector runtime behaviour configured by RPC, modelled on
 * auto-meter — same shape, same persistence table, same independence from
 * whether a scenario is loaded.
 */
export interface AutoTrafficConfig {
  enabled: boolean;
  /**
   * Seed for every random draw. Reproducibility is the point: a CI failure
   * that only shows up under an hour of background load is worthless if it
   * cannot be replayed.
   */
  seed: number;
  minDurationSec: number;
  maxDurationSec: number;
  minGapSec: number;
  maxGapSec: number;
  /** 0..1, rolled per attempt. Below 1 the connector sometimes idles. */
  probabilityOfStart: number;
  requireAuthorize: boolean;
  /** Stop generating after this long. Absent means "until turned off". */
  stopAfterSec?: number;
  /**
   * Stop generating at this absolute time (ISO 8601, #603). Whichever of
   * this and `stopAfterSec` comes first ends the traffic. A session open at
   * that moment is allowed to finish, like one open at `stopAfterSec`.
   */
  stopAt?: string;
  /**
   * How the idTag of a session is drawn from the charge point's idTag pool
   * (#603). Absent means the distribution the pool was created with. With no
   * pool the traffic presents {@link AUTO_TRAFFIC_ID_TAG}.
   */
  idTagStrategy?: IdTagDistribution;
  /**
   * The charge point's position in a fleet (#603), mixed into the idTag draw
   * so the charge points of one fleet that share a pool do not all present
   * the same tag first. Absent: a stable hash of the charge point id.
   */
  cpIndex?: number;
  /**
   * What decides when a session ends (#327). `"duration"` (the default, and
   * what an absent field means) draws a length and stops after it, so a
   * seed recorded before this field existed replays byte for byte.
   * `"intent"` draws a {@link AutoTrafficIntent} (opening and target SoC)
   * and stops the session when the vehicle reaches the target;
   * `minDurationSec`..`maxDurationSec` becomes the ceiling for a session
   * whose vehicle never gets there.
   */
  sessionModel?: AutoTrafficSessionModel;
  /** `"intent"` only: bounds of the drawn opening SoC in percent
   *  (default {@link DEFAULT_INTENT_SOC_RANGE}). */
  initialSocMin?: number;
  initialSocMax?: number;
  /** `"intent"` only: bounds of the drawn target SoC in percent. A draw at or
   *  below the opening SoC is raised to one point above it (capped at 100). */
  targetSocMin?: number;
  targetSocMax?: number;
  /**
   * A weighted pool of vehicles (#627): each cycle draws one, from its own
   * seeded stream, and the session charges as that vehicle, so the traffic
   * is a mix of cars instead of the connector's one fixed vehicle. Absent
   * or empty, the connector's current EV settings are the vehicle and the
   * draws of every other field are unchanged.
   */
  vehiclePool?: AutoTrafficVehicle[];
}

/**
 * One vehicle of {@link AutoTrafficConfig.vehiclePool}: a **copy** of what a
 * vehicle profile resolves to (`resolveEvSettings`), taken when the pool is
 * saved. Nothing reads a profile or the catalog while the traffic runs, so
 * the pool works offline and an edit of the profile does not change it (the
 * offline guarantee of vehicle profiles, #458).
 */
export interface AutoTrafficVehicle {
  /** Relative weight, a finite number above 0. `[3, 1]` draws the first
   *  vehicle three times in four. */
  weight: number;
  /** The profile this was resolved from; a label for counters and logs. */
  profileId?: string;
  /** The vehicle itself, the vehicle part of `EVSettings`. */
  vehicle: AutoTrafficVehicleSettings;
}

/** The part of EV settings a vehicle determines; the session's own SoCs and
 *  the electrical values a vehicle does not determine are not in it. */
export type AutoTrafficVehicleSettings = Pick<
  EVSettings,
  "modelName" | "batteryCapacityKwh" | "maxChargingPowerKw"
> &
  Partial<
    Pick<EVSettings, "chargingCurve" | "currentType" | "phases" | "attribution">
  >;

/** The label a pool vehicle is counted and logged under. */
export function autoTrafficVehicleLabel(entry: AutoTrafficVehicle): string {
  return entry.profileId ?? entry.vehicle.modelName;
}

/**
 * The EV settings patch that makes a connector this vehicle. Replaces the
 * previous vehicle whole: a field the vehicle lacks is removed (`null`), never
 * left to the vehicle before it, because the connector merges a patch into its
 * settings (see `applyVehicleSettings`, docs/concepts/vehicle-profiles.md).
 */
export function autoTrafficVehiclePatch(
  entry: AutoTrafficVehicle,
): EVSettingsPatch {
  const v = entry.vehicle;
  return {
    modelName: v.modelName,
    batteryCapacityKwh: v.batteryCapacityKwh,
    maxChargingPowerKw: v.maxChargingPowerKw,
    chargingCurve: v.chargingCurve ?? [],
    currentType: v.currentType ?? null,
    phases: v.phases ?? null,
    attribution: v.attribution ?? null,
  };
}

/**
 * Index of the entry a uniform draw `unit` in [0, 1) selects, each entry in
 * proportion to its weight. Pure, so "same seed, same sequence" is a property
 * of the draw alone.
 */
export function pickWeightedIndex(
  weights: readonly number[],
  unit: number,
): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let point = unit * total;
  for (let i = 0; i < weights.length; i++) {
    point -= weights[i]!;
    if (point < 0) return i;
  }
  return weights.length - 1;
}

export type AutoTrafficSessionModel = "duration" | "intent";

/** Default bounds of the intent draws, in percent. */
export const DEFAULT_INTENT_SOC_RANGE = {
  initialSocMin: 10,
  initialSocMax: 50,
  targetSocMin: 70,
  targetSocMax: 100,
} as const;

/** What one drawn session asks of the vehicle (`sessionModel: "intent"`). */
export interface AutoTrafficIntent {
  initialSoc: number;
  targetSoc: number;
}

export const defaultAutoTrafficConfig: AutoTrafficConfig = {
  enabled: false,
  seed: 1,
  minDurationSec: 60,
  maxDurationSec: 300,
  minGapSec: 30,
  maxGapSec: 120,
  probabilityOfStart: 1,
  requireAuthorize: true,
};

/** What the generator decided to do next. */
export interface AutoTrafficStep {
  /** Wait this long before the attempt. */
  gapSec: number;
  /** Whether the attempt actually starts a session. */
  start: boolean;
  /** Session length, meaningful only when `start`. Under
   *  `sessionModel: "intent"` it is the ceiling, not the plan. */
  durationSec: number;
  /** The session's SoC intent; present only under `sessionModel: "intent"`. */
  intent?: AutoTrafficIntent;
  /** Index into `vehiclePool` of the drawn vehicle; present only with a pool (#627). */
  vehicleIndex?: number;
}

/**
 * Per-connector counters, exposed on connector status.
 *
 * The assertion surface for a load run, and what `/metrics` aggregates. Kept
 * on the plan rather than derived from logs so a test can read them directly.
 */
export interface AutoTrafficCounters {
  /** Cycles that ran: a scenario suspending the connector is not one. */
  attempted: number;
  /** Sessions begun (the start was accepted). */
  started: number;
  /** Cycles that did not start a session: the roll came below
   *  `probabilityOfStart`, or a start precondition failed (#603). */
  skipped: number;
  /** The Authorize or the start was refused, so no session began. */
  rejected: number;
  completed: number;
  authorizeAccepted: number;
  authorizeRejected: number;
  startAccepted: number;
  startRejected: number;
  stopAccepted: number;
  stopRejected: number;
  /** Cycles skipped in a row since the last session begun (#603). */
  consecutiveSkips: number;
  /** When the first and the latest cycle ran, epoch ms (#603). */
  firstRunAt: number | null;
  lastRunAt: number | null;
  /**
   * Sessions begun per pool vehicle, by {@link autoTrafficVehicleLabel}
   * (#627). Absent until a session of a pooled vehicle begins.
   */
  vehicles?: Record<string, number>;
}

export function emptyAutoTrafficCounters(): AutoTrafficCounters {
  return {
    attempted: 0,
    started: 0,
    skipped: 0,
    rejected: 0,
    completed: 0,
    authorizeAccepted: 0,
    authorizeRejected: 0,
    startAccepted: 0,
    startRejected: 0,
    stopAccepted: 0,
    stopRejected: 0,
    consecutiveSkips: 0,
    firstRunAt: null,
    lastRunAt: null,
  };
}

/**
 * The idTag stream of one connector's traffic (#603).
 *
 * `ChargePoint.nextIdTag` draws from state the whole charge point shares
 * (the round-robin cursor, the stream seeded by the charge point id), which
 * scenarios and control-plane calls advance too, so what traffic presents
 * would depend on what else ran. This reads the same tag list and
 * distribution and keeps its own cursor and stream, seeded by the traffic
 * seed: the same seed gives the same sequence.
 *
 * - `round-robin`: the next tag, from a start offset that mixes in the charge
 *   point index and the connector.
 * - `random`: drawn from a stream seeded by the seed, the charge point id,
 *   the index and the connector.
 * - `connector-affinity`: a connector always presents the same tag, shifted
 *   by the charge point index so the charge points of a fleet spread over
 *   the pool.
 */
/** `2026-11-09T10:00:00Z`, `...+09:00`, with optional fractional seconds. */
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export class AutoTrafficIdTagPicker {
  private readonly rng: () => number;
  private cursor: number;
  private readonly index: number;
  private readonly tagsOf: () => readonly string[];

  /**
   * `tags` may be a function: a `--watch` reload swaps the pool's list
   * (#314), and the next draw must see it.
   */
  constructor(
    tags: readonly string[] | (() => readonly string[]),
    private readonly strategy: IdTagDistribution,
    seed: number,
    cpId: string,
    private readonly connectorId: number,
    cpIndex: number | undefined,
  ) {
    this.tagsOf = typeof tags === "function" ? tags : () => tags;
    if (this.tagsOf().length === 0) throw new Error("no idTags to draw from");
    const index = cpIndex ?? cyrb128(`cp-index:${cpId}`)[0]!;
    this.index = index >>> 0;
    this.cursor = this.index + Math.max(0, connectorId - 1);
    const state = cyrb128(`${seed}:${cpId}:${index}:${connectorId}:idtag`);
    this.rng = xoshiro128ss(
      state.every((word) => word === 0) ? [1, 2, 3, 4] : state,
    );
  }

  next(): string {
    const tags = this.tagsOf();
    if (this.strategy === "connector-affinity") {
      return tags[
        (this.index + Math.max(0, this.connectorId - 1)) % tags.length
      ]!;
    }
    if (this.strategy === "random") {
      return tags[draw(this.rng, tags.length)]!;
    }
    const tag = tags[this.cursor % tags.length]!;
    this.cursor++;
    return tag;
  }
}

/**
 * The seeded decision stream for one connector.
 *
 * Pure and synchronous: it decides, the runtime waits and acts. That is what
 * makes "same seed, same sequence" testable without a clock — the seed fixes
 * the *draws*, not the wall clock, so an assertion belongs on the drawn values
 * or on observed times within a tolerance, never on exact timestamps.
 */
export class AutoTrafficPlanner {
  private readonly rng: () => number;
  /**
   * The vehicle draws have a stream of their own (#627), so a pool changes
   * which car a session is and nothing else: the gaps, durations, intents and
   * rolls of a seed are the ones it gives without a pool.
   */
  private readonly vehicleRng: () => number;

  constructor(
    private readonly config: AutoTrafficConfig,
    cpId: string,
    connectorId: number,
  ) {
    // Derived per connector so two connectors of one charge point — and two
    // charge points of one fleet — do not step in lockstep.
    const state = cyrb128(`${config.seed}:${cpId}:${connectorId}`);
    this.rng = xoshiro128ss(
      state.every((word) => word === 0) ? [1, 2, 3, 4] : state,
    );
    const vehicleState = cyrb128(
      `${config.seed}:${cpId}:${connectorId}:vehicle`,
    );
    this.vehicleRng = xoshiro128ss(
      vehicleState.every((word) => word === 0) ? [1, 2, 3, 4] : vehicleState,
    );
  }

  /** Decide the next gap, whether to start, and for how long. */
  next(): AutoTrafficStep {
    const gapSec = this.between(this.config.minGapSec, this.config.maxGapSec);
    // Drawn unconditionally, before the probability gate, so the sequence a
    // seed produces does not depend on which attempts happened to fire.
    const durationSec = this.between(
      this.config.minDurationSec,
      this.config.maxDurationSec,
    );
    // The intent is drawn after the duration and before the roll, in a fixed
    // order and unconditionally, so it too does not depend on which attempts
    // fired. `"duration"` draws nothing here: its stream is unchanged.
    const intent =
      this.config.sessionModel === "intent" ? this.drawIntent() : undefined;
    const roll = draw(this.rng, 1_000_000) / 1_000_000;
    // Drawn on every step, whether or not the attempt fires, so the vehicle
    // sequence does not depend on which attempts did (#627).
    const pool = this.config.vehiclePool;
    const vehicleIndex =
      pool && pool.length > 0
        ? pickWeightedIndex(
            pool.map((entry) => entry.weight),
            (this.vehicleRng() >>> 0) / 4_294_967_296,
          )
        : undefined;
    return {
      gapSec,
      start: roll < this.config.probabilityOfStart,
      durationSec,
      ...(intent ? { intent } : {}),
      ...(vehicleIndex !== undefined ? { vehicleIndex } : {}),
    };
  }

  private drawIntent(): AutoTrafficIntent {
    const range = { ...DEFAULT_INTENT_SOC_RANGE };
    const c = this.config;
    const initialSoc = this.between(
      c.initialSocMin ?? range.initialSocMin,
      c.initialSocMax ?? range.initialSocMax,
    );
    const drawnTarget = this.between(
      c.targetSocMin ?? range.targetSocMin,
      c.targetSocMax ?? range.targetSocMax,
    );
    return {
      initialSoc,
      targetSoc: Math.max(drawnTarget, Math.min(100, initialSoc + 1)),
    };
  }

  private between(min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    if (hi <= lo) return lo;
    return lo + draw(this.rng, hi - lo + 1);
  }
}

/** Reject a config the runtime could not act on. Returns the reason, or null. */
export function validateAutoTrafficConfig(
  config: AutoTrafficConfig,
): string | null {
  // Presence first. Every comparison below is false against a missing field,
  // so `{ enabled: true, seed: 1 }` validated, the planner produced NaN gaps,
  // and `setTimeout(NaN)` fires immediately — a non-starting step then
  // rescheduled itself in a hot loop.
  for (const key of [
    "seed",
    "minDurationSec",
    "maxDurationSec",
    "minGapSec",
    "maxGapSec",
    "probabilityOfStart",
  ] as const) {
    if (!Number.isFinite(config[key])) return `${key} must be a finite number`;
  }
  if (typeof config.enabled !== "boolean") return "enabled must be a boolean";
  if (typeof config.requireAuthorize !== "boolean") {
    return "requireAuthorize must be a boolean";
  }
  if (
    config.stopAfterSec !== undefined &&
    !Number.isFinite(config.stopAfterSec)
  ) {
    return "stopAfterSec must be a finite number";
  }
  if (config.minDurationSec < 1) return "minDurationSec must be at least 1";
  if (config.maxDurationSec < config.minDurationSec) {
    return "maxDurationSec must be at least minDurationSec";
  }
  if (config.minGapSec < 0) return "minGapSec must be at least 0";
  if (config.maxGapSec < config.minGapSec) {
    return "maxGapSec must be at least minGapSec";
  }
  if (config.probabilityOfStart < 0 || config.probabilityOfStart > 1) {
    return "probabilityOfStart must be between 0 and 1";
  }
  if (config.stopAfterSec !== undefined && config.stopAfterSec < 1) {
    return "stopAfterSec must be at least 1";
  }
  if (
    config.stopAt !== undefined &&
    (typeof config.stopAt !== "string" ||
      !ISO_DATE_TIME_WITH_OFFSET.test(config.stopAt) ||
      Number.isNaN(Date.parse(config.stopAt)))
  ) {
    return "stopAt must be an ISO 8601 date-time with an offset (for example 2026-11-09T10:00:00Z)";
  }
  if (
    config.idTagStrategy !== undefined &&
    !["round-robin", "random", "connector-affinity"].includes(
      config.idTagStrategy,
    )
  ) {
    return 'idTagStrategy must be "round-robin", "random" or "connector-affinity"';
  }
  if (
    config.sessionModel !== undefined &&
    config.sessionModel !== "duration" &&
    config.sessionModel !== "intent"
  ) {
    return 'sessionModel must be "duration" or "intent"';
  }
  for (const key of [
    "initialSocMin",
    "initialSocMax",
    "targetSocMin",
    "targetSocMax",
  ] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return `${key} must be a number between 0 and 100`;
    }
  }
  if (
    (config.initialSocMin ?? 0) >
    (config.initialSocMax ?? DEFAULT_INTENT_SOC_RANGE.initialSocMax)
  ) {
    return "initialSocMax must be at least initialSocMin";
  }
  if (
    (config.targetSocMin ?? 0) >
    (config.targetSocMax ?? DEFAULT_INTENT_SOC_RANGE.targetSocMax)
  ) {
    return "targetSocMax must be at least targetSocMin";
  }
  const poolProblem = validateVehiclePool(config.vehiclePool);
  if (poolProblem) return poolProblem;
  if (
    config.cpIndex !== undefined &&
    (!Number.isInteger(config.cpIndex) || config.cpIndex < 0)
  ) {
    return "cpIndex must be a non-negative integer";
  }
  return null;
}

/** Reject a vehicle pool the traffic could not draw from (#627). */
function validateVehiclePool(pool: unknown): string | null {
  if (pool === undefined) return null;
  if (!Array.isArray(pool)) return "vehiclePool must be an array";
  if (pool.length === 0) {
    return "vehiclePool must not be empty (omit it to use the connector's EV settings)";
  }
  for (const [i, entry] of pool.entries()) {
    const at = `vehiclePool[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      return `${at} must be an object`;
    }
    const { weight, vehicle } = entry as Partial<AutoTrafficVehicle>;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      return `${at}.weight must be a finite number above 0`;
    }
    if (typeof vehicle !== "object" || vehicle === null) {
      return `${at}.vehicle must be an object`;
    }
    if (typeof vehicle.modelName !== "string" || vehicle.modelName === "") {
      return `${at}.vehicle.modelName must be a non-empty string`;
    }
    for (const key of ["batteryCapacityKwh", "maxChargingPowerKw"] as const) {
      const value = vehicle[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return `${at}.vehicle.${key} must be a finite number above 0`;
      }
    }
    if (
      vehicle.currentType !== undefined &&
      vehicle.currentType !== "AC" &&
      vehicle.currentType !== "DC"
    ) {
      return `${at}.vehicle.currentType must be "AC" or "DC"`;
    }
    if (
      vehicle.phases !== undefined &&
      vehicle.phases !== 1 &&
      vehicle.phases !== 3
    ) {
      return `${at}.vehicle.phases must be 1 or 3`;
    }
    if (vehicle.chargingCurve !== undefined) {
      if (!Array.isArray(vehicle.chargingCurve)) {
        return `${at}.vehicle.chargingCurve must be an array`;
      }
      for (const point of vehicle.chargingCurve) {
        if (
          !Number.isFinite(point?.socPercent) ||
          point.socPercent < 0 ||
          point.socPercent > 100 ||
          !Number.isFinite(point?.powerFraction) ||
          point.powerFraction < 0 ||
          point.powerFraction > 1
        ) {
          return `${at}.vehicle.chargingCurve points need socPercent 0-100 and powerFraction 0-1`;
        }
      }
    }
  }
  return null;
}

/**
 * The idTag background traffic presents when its charge point has no idTag
 * pool (#603). With a pool, {@link AutoTrafficIdTagPicker} draws from it.
 */
export const AUTO_TRAFFIC_ID_TAG = "123456";
