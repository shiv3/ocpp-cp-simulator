import {
  cyrb128,
  draw,
  xoshiro128ss,
} from "../../infrastructure/transport/network-sim/SeededRng";

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
  /** Session length, meaningful only when `start`. */
  durationSec: number;
}

/**
 * Per-connector counters, exposed on connector status.
 *
 * The assertion surface for a load run, and what `/metrics` aggregates. Kept
 * on the plan rather than derived from logs so a test can read them directly.
 */
export interface AutoTrafficCounters {
  attempted: number;
  started: number;
  /** Rolled below `probabilityOfStart`. */
  skipped: number;
  /** The CSMS refused the Authorize, so no session began. */
  rejected: number;
  completed: number;
}

export function emptyAutoTrafficCounters(): AutoTrafficCounters {
  return { attempted: 0, started: 0, skipped: 0, rejected: 0, completed: 0 };
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
    const roll = draw(this.rng, 1_000_000) / 1_000_000;
    return {
      gapSec,
      start: roll < this.config.probabilityOfStart,
      durationSec,
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
  return null;
}

/**
 * The idTag background traffic presents.
 *
 * A fixed literal for now: #299 adds a per-charge-point pool, and this is the
 * single place that will draw from it once both have landed.
 */
export const AUTO_TRAFFIC_ID_TAG = "123456";
