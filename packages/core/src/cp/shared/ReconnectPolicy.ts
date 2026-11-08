import { MAX_TIMER_MS } from "./timers";

/**
 * The reconnect policy of a charge point's WebSocket client (#609).
 *
 * Pure: the transport asks {@link nextReconnectDelayMs} how long to wait
 * before attempt N and whether to give up, so the schedule is testable
 * without a socket or a timer.
 */

export type ReconnectMode = "exponential" | "fixed";

export interface ReconnectPolicy {
  /** Reconnect attempts after a connection loss before the charge point
   *  gives up. `-1` = unlimited, `0` = never reconnect. */
  readonly maxAttempts: number;
  /** `exponential` doubles the delay every attempt; `fixed` waits
   *  `baseDelayMs` every time. */
  readonly mode: ReconnectMode;
  /** Delay before the first attempt, in ms. */
  readonly baseDelayMs: number;
  /** Cap of the exponential delay, in ms. */
  readonly maxDelayMs: number;
  /** A random extra delay drawn uniformly from [0, jitterMs], in ms, from
   *  the charge point's seeded `reconnect` stream. */
  readonly jitterMs: number;
  /** Automatic BootNotification re-sends after a `Rejected` answer before
   *  the charge point stops. `-1` = unlimited. */
  readonly bootRetryLimit: number;
}

/** What the transport did before the policy was configurable: 1 s doubling
 *  up to 30 s, forever, no jitter; BootNotification retried forever. */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = Object.freeze({
  maxAttempts: -1,
  mode: "exponential",
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterMs: 0,
  bootRetryLimit: -1,
});

/**
 * OCPP 2.0.1 / 2.1 Part 4 §5.4 "Reconnecting", with the OCPPCommCtrlr
 * variables of the Part 2 Appendices: `RetryBackOffWaitMinimum` (s),
 * `RetryBackOffRandomRange` (s) and `RetryBackOffRepeatTimes`. Replaces the policy's base delay, jitter and
 * number of doublings on a 2.x charge point.
 */
export interface RetryBackOffVariables {
  readonly waitMinimumSeconds: number;
  readonly randomRangeSeconds: number;
  readonly repeatTimes: number;
}

export function resolveReconnectPolicy(
  partial?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  const policy = { ...DEFAULT_RECONNECT_POLICY, ...stripUndefined(partial) };
  const problem = validateReconnectPolicy(policy);
  if (problem) throw new RangeError(problem);
  return Object.freeze(policy);
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= -1;
}

/** `undefined` when valid, else the first problem, for an error message. */
export function validateReconnectPolicy(
  policy: ReconnectPolicy,
): string | undefined {
  if (!isCount(policy.maxAttempts)) {
    return "reconnect.maxAttempts must be an integer >= -1 (-1 = unlimited)";
  }
  if (!isCount(policy.bootRetryLimit)) {
    return "reconnect.bootRetryLimit must be an integer >= -1 (-1 = unlimited)";
  }
  if (policy.mode !== "exponential" && policy.mode !== "fixed") {
    return 'reconnect.mode must be "exponential" or "fixed"';
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    return "reconnect.baseDelayMs must be a number >= 0";
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0) {
    return "reconnect.maxDelayMs must be a number >= 0";
  }
  // `fixed` never reads maxDelayMs, so only the exponential cap must hold it.
  if (policy.mode === "exponential" && policy.maxDelayMs < policy.baseDelayMs) {
    return "reconnect.maxDelayMs must be >= reconnect.baseDelayMs";
  }
  if (!Number.isFinite(policy.jitterMs) || policy.jitterMs < 0) {
    return "reconnect.jitterMs must be a number >= 0";
  }
  return undefined;
}

/** The 2.x variables a policy implies, so the variable defaults match the
 *  behaviour the policy gives (whole seconds, at least 1 for the wait). */
export function retryBackOffDefaults(
  policy: ReconnectPolicy,
): RetryBackOffVariables {
  const doublings =
    policy.mode === "fixed" || policy.baseDelayMs <= 0
      ? 0
      : Math.max(
          0,
          Math.ceil(
            Math.log2(Math.max(1, policy.maxDelayMs / policy.baseDelayMs)),
          ),
        );
  return {
    waitMinimumSeconds: Math.max(1, Math.ceil(policy.baseDelayMs / 1000)),
    randomRangeSeconds: Math.ceil(policy.jitterMs / 1000),
    // RetryBackOffRepeatTimes is at most 30: GetVariables must not report a
    // value SetVariables would reject.
    repeatTimes: Math.min(30, doublings),
  };
}

export type ReconnectDecision =
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "give-up" };

/**
 * The wait before reconnect attempt `attempt` (1-based).
 *
 * Without `variables` (1.6, or no 2.x variables) the wait is
 * `min(baseDelayMs * 2^(attempt-1), maxDelayMs) + jitter` in `exponential`
 * mode and `baseDelayMs + jitter` in `fixed` mode.
 *
 * With `variables` (2.x, Part 4 §5.4) the wait is
 * `RetryBackOffWaitMinimum * 2^min(attempt-1, RetryBackOffRepeatTimes)`
 * plus a random time in [0, `RetryBackOffRandomRange`]: it doubles for
 * `RetryBackOffRepeatTimes` attempts and then stays constant. The spec sets no
 * ceiling, so a CSMS's values are followed as they are (only the timer's own
 * limit applies). The one exception keeps today's schedule: while the three
 * variables still equal {@link retryBackOffDefaults} of the policy (nobody
 * changed them) the policy's `maxDelayMs` caps the doubled part, so the
 * default 1, 2, 4, 8, 16, 30 s does not become 32 s on the sixth attempt.
 * `fixed` mode never doubles.
 *
 * `random` returns a number in [0, 1).
 */
export function nextReconnectDelayMs(
  policy: ReconnectPolicy,
  attempt: number,
  random: () => number,
  variables?: RetryBackOffVariables | null,
): ReconnectDecision {
  if (policy.maxAttempts >= 0 && attempt > policy.maxAttempts) {
    return { kind: "give-up" };
  }
  const step = Math.max(0, attempt - 1);
  let waitMs: number;
  let jitterMs: number;
  if (variables) {
    const minimumMs = variables.waitMinimumSeconds * 1000;
    const doublings =
      policy.mode === "fixed" ? 0 : Math.min(step, variables.repeatTimes);
    const derived = retryBackOffDefaults(policy);
    const untouched =
      variables.waitMinimumSeconds === derived.waitMinimumSeconds &&
      variables.randomRangeSeconds === derived.randomRangeSeconds &&
      variables.repeatTimes === derived.repeatTimes;
    const doubled = minimumMs * 2 ** doublings;
    waitMs = Math.min(
      untouched ? Math.min(doubled, policy.maxDelayMs) : doubled,
      MAX_TIMER_MS,
    );
    jitterMs = variables.randomRangeSeconds * 1000;
  } else {
    waitMs =
      policy.mode === "fixed"
        ? policy.baseDelayMs
        : Math.min(
            policy.baseDelayMs * 2 ** Math.min(step, 60),
            policy.maxDelayMs,
          );
    jitterMs = policy.jitterMs;
  }
  // Only draw when there is jitter: a policy without it must not advance the
  // seeded stream.
  const extra = jitterMs > 0 ? Math.floor(random() * (jitterMs + 1)) : 0;
  // A sum past the timer's limit would fire at once (a reconnect storm).
  return { kind: "retry", delayMs: Math.min(waitMs + extra, MAX_TIMER_MS) };
}
