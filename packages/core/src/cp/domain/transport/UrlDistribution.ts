/**
 * How a charge point picks among several supervision URLs.
 *
 * - `round-robin` — advance on every connection attempt. A dead node drains
 *   after one attempt.
 * - `random` — draw per attempt, from a seeded stream so a run replays.
 * - `cp-affinity` — hash the `cpId` to a **primary** and stay on it. See
 *   `SupervisionUrlPool` (infrastructure/transport) for what "stay" means
 *   when the primary is down.
 */
export type UrlDistribution = "round-robin" | "random" | "cp-affinity";
