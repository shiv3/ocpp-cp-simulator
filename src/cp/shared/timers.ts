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
