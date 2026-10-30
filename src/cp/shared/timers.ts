/**
 * The longest delay `setTimeout` / `setInterval` honour. Node and Bun clamp
 * anything above 2^31-1 ms to 1 ms, so a longer delay fires immediately.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Let the process exit while `timer` is pending (Node / Bun). Browser timers
 * are plain numbers and have nothing to unref.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export interface TimeoutAtOptions {
  /** The clock `fireAt` is read against; `Date.now` by default. */
  readonly now?: () => number;
  /** Unref every timer of the chain (see {@link unrefTimer}). */
  readonly unref?: boolean;
}

/**
 * Call `callback` once `now()` reaches `fireAt` (epoch ms), never earlier:
 * a wait beyond {@link MAX_TIMER_MS} is chained instead of firing at once,
 * and a timer that fires early is re-armed. Always asynchronous, even for a
 * past `fireAt`. Returns the function that cancels the pending timer,
 * whichever link of the chain it is.
 */
export function setTimeoutAt(
  fireAt: number,
  callback: () => void,
  options: TimeoutAtOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(
      () => {
        if (now() < fireAt) arm();
        else callback();
      },
      Math.min(Math.max(0, fireAt - now()), MAX_TIMER_MS),
    );
    if (options.unref) unrefTimer(timer);
  };
  arm();
  return () => clearTimeout(timer);
}
