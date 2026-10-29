import type { CpBulkResult } from "../../protocol";

/**
 * `cp.bulk` fan-out (#470): run one action on every selected charge point at
 * once and report each outcome. Partial success is the result, not an error —
 * one unreachable CSMS must not hide the charge points that did what they were
 * asked.
 *
 * In parallel, and each wait capped at `waitMs`, because the per-CP `connect`
 * waits up to 30 s — exactly the RPC deadline. Awaited one after another, or
 * without a cap, a single blackholed CSMS would time the whole call out after
 * every side effect had happened, and the caller would get no report at all.
 * A charge point past the cap is reported as failed; its action keeps running.
 */
export async function runCpBulk(
  cpIds: readonly string[],
  act: (cpId: string) => Promise<void>,
  options: {
    readonly waitMs: number;
    readonly failureReason: (err: unknown) => string;
  },
): Promise<CpBulkResult> {
  // One cap for the whole batch: every action starts in the same tick, so a
  // timer per charge point would only be up to 1,000 timers due together.
  // `Promise.race` keeps a handler on each action, so a rejection landing
  // after the cap is not left unhandled.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`no outcome within ${options.waitMs} ms; still running`),
        ),
      options.waitMs,
    );
  });
  const outcomes = await Promise.allSettled(
    cpIds.map((cpId) => Promise.race([act(cpId), cap])),
  ).finally(() => clearTimeout(timer));
  const succeeded: string[] = [];
  const failed: Array<{ cpId: string; reason: string }> = [];
  outcomes.forEach((outcome, index) => {
    const cpId = cpIds[index];
    if (outcome.status === "fulfilled") succeeded.push(cpId);
    else failed.push({ cpId, reason: options.failureReason(outcome.reason) });
  });
  return { matched: [...cpIds], succeeded, failed };
}
