import { cyrb128, draw, xoshiro128ss } from "../../shared/SeededRng";
import type { IdTagDistribution } from "../auth/IdTagPool";

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
  if (
    config.stopAt !== undefined &&
    (typeof config.stopAt !== "string" ||
      Number.isNaN(Date.parse(config.stopAt)))
  ) {
    return "stopAt must be an ISO 8601 date-time";
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
    config.cpIndex !== undefined &&
    (!Number.isInteger(config.cpIndex) || config.cpIndex < 0)
  ) {
    return "cpIndex must be a non-negative integer";
  }
  return null;
}

/**
 * The idTag background traffic presents when its charge point has no idTag
 * pool (#603). With a pool, {@link AutoTrafficIdTagPicker} draws from it.
 */
export const AUTO_TRAFFIC_ID_TAG = "123456";
