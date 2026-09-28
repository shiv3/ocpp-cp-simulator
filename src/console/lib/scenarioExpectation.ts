import type { ScenarioExpectation } from "../../cp/application/scenario/ScenarioTypes";

/** `m:ss` for a duration in ms (negative clamps to 0:00). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** What a parked node awaits, in one short label: the OCPP action, the
 *  target connector status, or the connection event — flagged when the
 *  match is further constrained on the payload. */
export function describeExpectation(expectation: ScenarioExpectation): string {
  const payloadConditioned = Boolean(
    expectation.constraints &&
    (expectation.constraints as Record<string, unknown>).payload,
  );
  return `${
    expectation.action ??
    expectation.targetStatus ??
    expectation.event ??
    expectation.type
  }${payloadConditioned ? " (payload condition)" : ""}`;
}

/** Ms left before the parked node times out, or null when it waits forever.
 *  An unknown node start time counts as "just started". */
export function remainingWaitMs(
  expectation: ScenarioExpectation,
  currentNodeStartedAt: number | null,
  now: number,
): number | null {
  if (!expectation.timeoutMs) return null;
  const elapsedMs = now - (currentNodeStartedAt ?? now);
  return Math.max(0, expectation.timeoutMs - elapsedMs);
}
