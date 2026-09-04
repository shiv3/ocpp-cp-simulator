import { cyrb128, draw, xoshiro128ss } from "./network-sim/SeededRng";

/**
 * How a charge point picks among several supervision URLs.
 *
 * - `round-robin` — advance on every connection attempt. A dead node drains
 *   after one attempt.
 * - `random` — draw per attempt, from a seeded stream so a run replays.
 * - `cp-affinity` — hash the `cpId` to a **primary** and stay on it. See
 *   {@link SupervisionUrlPool} for what "stay" means when the primary is down.
 */
export type UrlDistribution = "round-robin" | "random" | "cp-affinity";

export const DEFAULT_URL_DISTRIBUTION: UrlDistribution = "round-robin";

/**
 * How many consecutive failures `cp-affinity` tolerates on its primary before
 * trying another URL. Low enough that a genuinely dead node is left within
 * seconds of backoff, high enough that one refused handshake does not scatter
 * a fleet off its assigned nodes.
 */
export const DEFAULT_AFFINITY_FAILOVER_THRESHOLD = 3;

/**
 * Chooses which supervision URL the next connection attempt should use.
 *
 * Pure and synchronous by design — the transport asks for a URL, reports how
 * the attempt went, and this decides. Keeping the policy out of
 * `OCPPWebSocket` is what makes the failover semantics testable without a
 * socket.
 *
 * **`cp-affinity` is sticky, and that is a deliberate contract.** The two
 * plausible readings of "affinity" contradict each other once the primary is
 * unreachable: always return the primary (and never connect), or rotate like
 * round-robin (and lose the determinism that is the whole point). Neither is
 * right on its own, so:
 *
 * - the primary is retried while consecutive failures are below the threshold;
 * - on reaching it, the pool advances one URL and resets the counter, so a
 *   dead primary does not strand the charge point;
 * - **any success resets the offset to the primary**, so the next disconnect
 *   episode starts from the assigned node again. That is what "returns to the
 *   primary once it is reachable" means in practice: the pool never has to
 *   probe a node it is not currently talking to.
 */
export class SupervisionUrlPool {
  private readonly urls: readonly string[];
  private readonly primary: number;
  private readonly failoverThreshold: number;
  private readonly rng: () => number;
  private offset = 0;
  private consecutiveFailures = 0;
  private started = false;
  /**
   * The index `next()` last handed out. Held rather than recomputed because
   * `random` consumes the RNG to choose: recomputing in `current()` would draw
   * again, so merely inspecting the pool would change which node the next
   * attempt uses — and the first seeded draw would be thrown away by the
   * `current()` call that happens at wiring time.
   */
  private selected: number;

  constructor(
    urls: readonly string[],
    private readonly policy: UrlDistribution = DEFAULT_URL_DISTRIBUTION,
    cpId = "",
    options: { failoverThreshold?: number } = {},
  ) {
    if (urls.length === 0) {
      throw new Error("SupervisionUrlPool needs at least one URL");
    }
    this.urls = urls;
    this.failoverThreshold =
      options.failoverThreshold ?? DEFAULT_AFFINITY_FAILOVER_THRESHOLD;
    // Hashing the cpId (rather than, say, its position in a registry) is what
    // makes the assignment survive a restart and be identical on every
    // machine — the property that lets a test assert which node saw a session.
    const digest = cyrb128(cpId);
    this.primary = digest[0] % urls.length;
    this.selected = this.policy === "cp-affinity" ? this.primary : 0;
    const state = cyrb128(`supervision:${cpId}`);
    this.rng = xoshiro128ss(
      state.every((word) => word === 0) ? [1, 2, 3, 4] : state,
    );
  }

  /** The URL the next connection attempt should use. */
  next(): string {
    if (this.started && this.policy === "round-robin") this.offset++;
    this.started = true;
    this.selected = this.indexFor();
    return this.urls[this.selected]!;
  }

  /**
   * The URL `next()` last returned, without advancing. Before the first
   * `next()` this is the pool's starting point — for `random` the draw has not
   * happened yet, so it reports the first URL. Side-effect free for every
   * policy: inspecting the pool must not change which node the next attempt
   * uses, and must not burn the first seeded draw.
   */
  current(): string {
    return this.urls[this.selected]!;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    // Back to the assigned node for the next episode. Harmless for the other
    // policies, which do not treat any index as special.
    if (this.policy === "cp-affinity") this.offset = 0;
  }

  onFailure(): void {
    this.consecutiveFailures++;
    if (
      this.policy === "cp-affinity" &&
      this.consecutiveFailures >= this.failoverThreshold
    ) {
      this.offset++;
      this.consecutiveFailures = 0;
    }
  }

  /** Advances the RNG for `random`; call only from `next()`. */
  private indexFor(): number {
    if (this.policy === "random") {
      return draw(this.rng, this.urls.length);
    }
    return this.staticIndex();
  }

  /** The index the non-random policies point at, computed without side effects. */
  private staticIndex(): number {
    const base = this.policy === "cp-affinity" ? this.primary : 0;
    return (base + this.offset) % this.urls.length;
  }
}
