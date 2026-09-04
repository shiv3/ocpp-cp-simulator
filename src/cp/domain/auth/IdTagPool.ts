import {
  cyrb128,
  draw,
  xoshiro128ss,
} from "../../infrastructure/transport/network-sim/SeededRng";

/**
 * How a charge point picks an idTag when a call does not name one.
 *
 * - `round-robin` — next tag per draw, across the whole charge point.
 * - `random` — drawn from a stream seeded by the `cpId`, so a run replays.
 * - `connector-affinity` — a connector always presents the same tag, which is
 *   the realistic model for a captive fleet and the one that lets a test
 *   assert which tag a given connector used.
 */
export type IdTagDistribution = "round-robin" | "random" | "connector-affinity";

export const DEFAULT_ID_TAG_DISTRIBUTION: IdTagDistribution = "round-robin";

/**
 * A charge point's pool of idTags.
 *
 * Every place an idTag is needed took a literal, which is fine for one scripted
 * run and wrong for anything with more than one session: a fleet where every
 * charge point presents the same tag is not exercising the CSMS's
 * authorization cache, its local auth list, or its per-tag concurrency rules.
 *
 * Pure and synchronous — the transport asks for a tag, this decides — so the
 * distribution semantics are testable without a charge point.
 */
export class IdTagPool {
  private readonly tags: readonly string[];
  private readonly rng: () => number;
  private cursor = 0;

  constructor(
    tags: readonly string[],
    private readonly distribution: IdTagDistribution = DEFAULT_ID_TAG_DISTRIBUTION,
    cpId = "",
  ) {
    if (tags.length === 0) throw new Error("IdTagPool needs at least one tag");
    this.tags = tags;
    const state = cyrb128(`idtags:${cpId}`);
    this.rng = xoshiro128ss(
      state.every((word) => word === 0) ? [1, 2, 3, 4] : state,
    );
  }

  /**
   * The tag to present next.
   *
   * `connectorId` only matters for `connector-affinity`; the other policies
   * ignore it, so a caller with no connector in hand (a bare `authorize`) can
   * pass `0` and still get a sensible tag.
   */
  next(connectorId = 0): string {
    if (this.distribution === "connector-affinity") {
      // Modulo the connector rather than hashing it: connector ids are small,
      // dense and 1-based, so this spreads them across the pool exactly and
      // stays obvious to reason about in a test.
      return this.tags[Math.max(0, connectorId - 1) % this.tags.length]!;
    }
    if (this.distribution === "random") {
      return this.tags[draw(this.rng, this.tags.length)]!;
    }
    const tag = this.tags[this.cursor % this.tags.length]!;
    this.cursor++;
    return tag;
  }

  /** The tags, for reporting. */
  list(): readonly string[] {
    return this.tags;
  }
}

/**
 * The idTag used when a call names none and the charge point has no pool.
 *
 * The literal that has always been the scenario executor's fallback, named so
 * the two call sites that need it cannot drift apart.
 */
export const DEFAULT_ID_TAG = "123456";
