/**
 * assert.ts -- typed assertion DSL for scenario specs, mirroring lib.sh's
 * check_* helpers but operating on parsed {@link Frame}s (see ocpp.ts)
 * instead of grep windows, so response-status assertions correlate by
 * OCPP-J uniqueId rather than log adjacency.
 */

import {
  findCall,
  findResponseFor,
  type CallFrame,
  type Direction,
  type Frame,
} from "./ocpp";

export interface CheckResult {
  description: string;
  pass: boolean;
  detail?: string;
}

/** Accumulates PASS/FAIL check results for one scenario run. */
export class AssertRecorder {
  private checks: CheckResult[] = [];

  pass(description: string): void {
    this.checks.push({ description, pass: true });
  }

  fail(description: string, detail?: string): void {
    this.checks.push({ description, pass: false, detail });
  }

  get results(): readonly CheckResult[] {
    return this.checks;
  }

  get total(): number {
    return this.checks.length;
  }

  get failed(): number {
    return this.checks.filter((c) => !c.pass).length;
  }

  get verdict(): "PASS" | "FAIL" {
    return this.failed > 0 ? "FAIL" : "PASS";
  }
}

/** check_log_contains equivalent: at least one CALL exists for direction+action. */
export function assertSent(
  rec: AssertRecorder,
  frames: readonly Frame[],
  action: string,
  description = `${action}.req sent`,
): CallFrame | undefined {
  const call = findCall(frames, "sent", action);
  if (call) {
    rec.pass(description);
  } else {
    rec.fail(description, `no Sent CALL found for action=${action}`);
  }
  return call;
}

export function assertReceived(
  rec: AssertRecorder,
  frames: readonly Frame[],
  action: string,
  description = `${action}.req received`,
): CallFrame | undefined {
  const call = findCall(frames, "received", action);
  if (call) {
    rec.pass(description);
  } else {
    rec.fail(description, `no Received CALL found for action=${action}`);
  }
  return call;
}

/** check_log_not_contains equivalent, scoped to CALLs for one action/direction. */
export function assertNotSent(
  rec: AssertRecorder,
  frames: readonly Frame[],
  action: string,
  direction: Direction = "sent",
  description = `no ${action} ${direction}`,
): void {
  const call = findCall(frames, direction, action);
  if (call) {
    rec.fail(description, `unexpected ${direction} CALL found: ${call.raw}`);
  } else {
    rec.pass(description);
  }
}

export interface ResponseStatusOptions {
  /** Which side sent the CALL being answered (default "received": a
   *  CSMS-initiated op like RemoteStartTransaction). Pass "sent" for a
   *  CP-initiated op like BootNotification. */
  direction?: Direction;
  /** 0-indexed occurrence of `action`, for scenarios that repeat it
   *  (e.g. a Full then a Differential SendLocalList). */
  occurrence?: number;
}

/**
 * check_response_status / check_sent_result equivalent, upgraded to
 * uniqueId correlation: finds the `occurrence`-th CALL for `action` in
 * `direction`, then its response PAIRED BY uniqueId (not the next
 * CALLRESULT line in the log), and asserts payload.status === expected.
 */
export function assertResponseStatus(
  rec: AssertRecorder,
  frames: readonly Frame[],
  action: string,
  expectedStatus: string,
  description = `${action} -> status ${expectedStatus}`,
  options: ResponseStatusOptions = {},
): void {
  const direction = options.direction ?? "received";
  const occurrence = options.occurrence ?? 0;

  const call = findCall(frames, direction, action, occurrence);
  if (!call) {
    rec.fail(
      description,
      `no ${direction} CALL found for action=${action} (occurrence ${occurrence})`,
    );
    return;
  }

  const response = findResponseFor(frames, call);
  if (!response) {
    rec.fail(
      description,
      `no response frame found for uniqueId=${call.uniqueId} (${action})`,
    );
    return;
  }
  if (response.kind === "callerror") {
    rec.fail(
      description,
      `expected CALLRESULT, got CALLERROR ${response.errorCode}: ${response.errorDescription}`,
    );
    return;
  }

  const status = (response.payload as { status?: unknown } | null)?.status;
  if (status === expectedStatus) {
    rec.pass(description);
  } else {
    rec.fail(
      description,
      `expected status=${expectedStatus}, got status=${String(status)} (uniqueId=${call.uniqueId})`,
    );
  }
}

export function assertEq(
  rec: AssertRecorder,
  actual: unknown,
  expected: unknown,
  description: string,
): void {
  if (actual === expected) {
    rec.pass(description);
  } else {
    rec.fail(
      description,
      `expected '${String(expected)}', got '${String(actual)}'`,
    );
  }
}

export function assertTrue(
  rec: AssertRecorder,
  condition: boolean,
  description: string,
  detail?: string,
): void {
  if (condition) {
    rec.pass(description);
  } else {
    rec.fail(description, detail);
  }
}

/**
 * check_log_contains equivalent for checks that aren't about a specific
 * OCPP frame (scenario lifecycle structured events, free-text log
 * messages) -- scans raw stdout lines rather than parsed frames.
 */
export function assertLineMatches(
  rec: AssertRecorder,
  lines: readonly string[],
  pattern: RegExp,
  description: string,
): void {
  if (lines.some((line) => pattern.test(line))) {
    rec.pass(description);
  } else {
    rec.fail(description, `no line matched pattern: ${pattern}`);
  }
}

/** check_log_not_contains equivalent over raw stdout lines. */
export function assertNoLineMatches(
  rec: AssertRecorder,
  lines: readonly string[],
  pattern: RegExp,
  description: string,
): void {
  const hit = lines.find((line) => pattern.test(line));
  if (hit) {
    rec.fail(description, `unexpected line matched pattern ${pattern}: ${hit}`);
  } else {
    rec.pass(description);
  }
}
