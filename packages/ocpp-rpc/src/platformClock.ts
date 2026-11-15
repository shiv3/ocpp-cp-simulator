/**
 * The two timer operations the RPC layer needs. Any clock with these methods
 * fits, the simulator's virtual `SimClock` included; the handle is opaque.
 */
export interface RpcClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The platform timers, used when no clock is injected. Kept apart from the
 * code that arms timers so `scripts/check-direct-time.ts` can scan that code
 * for direct platform-time use.
 */
export const platformClock: RpcClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(
      handle as Parameters<typeof globalThis.clearTimeout>[0],
    ),
};
