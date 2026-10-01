/**
 * The longest delay `setTimeout` / `setInterval` honour. Node and Bun clamp
 * anything above 2^31-1 ms to 1 ms, so a longer delay fires immediately.
 */
export const MAX_TIMER_MS = 2_147_483_647;
