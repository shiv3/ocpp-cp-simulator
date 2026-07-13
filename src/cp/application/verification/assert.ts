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

/**
 * Variant of {@link assertResponseStatus} for CALLRESULTs that nest their
 * status under `idTagInfo.status` (StartTransaction.conf, Authorize.conf)
 * rather than a top-level `status` field. Same uniqueId-paired correlation.
 */
export function assertIdTagInfoStatus(
  rec: AssertRecorder,
  frames: readonly Frame[],
  action: string,
  expectedStatus: string,
  description: string,
  options: ResponseStatusOptions = {},
): void {
  const direction = options.direction ?? "sent";
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

  const status = (
    response.payload as { idTagInfo?: { status?: unknown } } | null
  )?.idTagInfo?.status;
  if (status === expectedStatus) {
    rec.pass(description);
  } else {
    rec.fail(
      description,
      `expected idTagInfo.status=${expectedStatus}, got status=${String(status)} (uniqueId=${call.uniqueId})`,
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

/**
 * check_log_order equivalent: passes if the FIRST line matching `patternA`
 * appears before the FIRST line matching `patternB`.
 */
export function assertLineOrder(
  rec: AssertRecorder,
  lines: readonly string[],
  patternA: RegExp,
  patternB: RegExp,
  description: string,
): void {
  const indexA = lines.findIndex((line) => patternA.test(line));
  const indexB = lines.findIndex((line) => patternB.test(line));
  if (indexA === -1 || indexB === -1) {
    rec.fail(
      description,
      `one or both patterns not found (A=${patternA} found=${indexA !== -1}, B=${patternB} found=${indexB !== -1})`,
    );
  } else if (indexA < indexB) {
    rec.pass(description);
  } else {
    rec.fail(
      description,
      `A (line ${indexA}) did not precede B (line ${indexB})`,
    );
  }
}

/**
 * check_log_after equivalent: passes if `pattern` matches some line
 * strictly after the LAST line matching `afterPattern`. Use this instead of
 * {@link assertLineOrder} when `pattern` could also match an earlier,
 * unrelated occurrence (e.g. a connector's automatic post-boot "Available"
 * StatusNotification, which always precedes any scenario-driven state
 * change and would make a first-match order check pass trivially).
 */
export function assertLineAfter(
  rec: AssertRecorder,
  lines: readonly string[],
  afterPattern: RegExp,
  pattern: RegExp,
  description: string,
): void {
  let afterIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (afterPattern.test(lines[i])) afterIndex = i;
  }
  if (afterIndex === -1) {
    rec.fail(description, `reference pattern not found: ${afterPattern}`);
    return;
  }
  const found = lines.slice(afterIndex + 1).some((line) => pattern.test(line));
  if (found) {
    rec.pass(description);
  } else {
    rec.fail(
      description,
      `pattern not found after line ${afterIndex} (${afterPattern}): ${pattern}`,
    );
  }
}

/**
 * check_db_nonempty equivalent, generic over an already-fetched value
 * (keeps assert.ts free of any SteveDb/SQL coupling -- callers fetch via
 * `db.scalar(...)` and pass the result in).
 */
export function assertNonEmpty(
  rec: AssertRecorder,
  value: string,
  description: string,
): void {
  if (value !== "") {
    rec.pass(`${description} (got '${value}')`);
  } else {
    rec.fail(description, "value was empty");
  }
}
