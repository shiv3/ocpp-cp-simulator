import type { ScenarioDefinition } from "./graph";

/**
 * #179 Phase 2b: the kind of check an {@link AssertionSpec} performs against
 * the captured OCPP wire transcript of one scenario run.
 */
export type AssertionType =
  | "ocpp_sent"
  | "ocpp_received"
  | "ocpp_absent"
  | "response_status"
  | "idtag_info_status"
  | "payload_match"
  | "message_order"
  | "message_after"
  | "state_transition"
  | "no_unexpected";

/**
 * How an assertion failure affects the run verdict (#247). "failure"
 * (default): normative OCPP conformance check; failing it fails the run.
 * "warning": compatibility observation (e.g. OCTT quirks); failing it yields
 * a compatibility WARNING, promoted to FAIL only in strict mode.
 */
export type AssertionSeverity = "failure" | "warning";

/**
 * Declarative assertion attached to a {@link ScenarioDefinition}. Evaluated
 * against the run's captured {@link Frame} transcript by
 * `evaluateAssertions` (packages/core/src/cp/application/verification/ScenarioAssertions.ts)
 * once the run ends. Field usage varies by `type` — see that module's
 * mapping doc.
 */
export interface AssertionSpec {
  /** Stable identifier; echoed on the corresponding {@link AssertionResult}. */
  id: string;
  description?: string;
  type: AssertionType;
  /** OCPP action for frame-based assertion types. */
  action?: string;
  direction?: "sent" | "received";
  /** Expected status for response_status / idtag_info_status. */
  status?: string;
  /**
   * Nth (0-indexed) occurrence of `action`. Default 0. `payload_match` also
   * takes `"any"` (schema 1.12): it passes when any CALL of `action` matches.
   */
  occurrence?: number | "any";
  /** Partial subset match against the matched CALL's payload (payload_match). */
  payload?: Record<string, unknown>;
  /** Expected connector status for state_transition. */
  targetStatus?: string;
  /** Set of actions that must not appear as a sent CALL (no_unexpected). */
  actions?: string[];
  /** Reference frame matcher for message_order / message_after. */
  before?: { action: string; direction?: "sent" | "received" };
  after?: { action: string; direction?: "sent" | "received" };
  /** How an assertion failure affects the run verdict. Default "failure". */
  severity?: AssertionSeverity;
}

/**
 * What a scenario needs from the CSMS to run its intended path (schema 1.12).
 * Machine-readable twin of the template description: an operator, a CSMS test
 * harness or an MCP client reads it to know which CSMS-initiated calls to send
 * and which answers to give, without opening the scenario graph.
 *
 * Payload examples may hold placeholders written as strings: `<transactionId>`
 * (the id the CSMS gave the running transaction), `<now+Ns>` (an ISO-8601
 * time N seconds from now), `<uploadUrl>` / `<firmwareUrl>` (a URL the CSMS
 * operator hosts). Everything else is literal.
 */
export interface CsmsExpectations {
  /**
   * CSMS-initiated calls the scenario waits for, in the order it waits for
   * them. Empty or absent: the scenario needs no CSMS-initiated call.
   */
  calls?: CsmsExpectedCall[];
  /**
   * Answers the CSMS must give to a call the charge point makes (an
   * Authorize outcome, a DataTransfer status). A call matching none of them
   * is answered the usual way (accepted).
   */
  answers?: CsmsExpectedAnswer[];
  /**
   * Charge-point-side steps outside the CSMS that a status-triggered scenario
   * waits for (plug in, start a transaction, ...), as simulator commands.
   */
  simulatorSteps?: CsmsSimulatorStep[];
  /** Free text: what is optional, what the run does when nothing is sent. */
  note?: string;
}

export interface CsmsExpectedCall {
  /** OCPP action the CSMS sends (e.g. `RemoteStartTransaction`). */
  action: string;
  /** Id of the scenario node that waits for this call. */
  node?: string;
  /** A payload that takes the intended path (version-specific wire shape). */
  example?: Record<string, unknown>;
  /** The status the charge point answers with when it takes the intended path. */
  expectedStatus?: string;
  /** The scenario does not need this call: without it a timeout edge runs. */
  optional?: boolean;
  note?: string;
}

export interface CsmsExpectedAnswer {
  /** OCPP action the charge point sends (e.g. `Authorize`). */
  action: string;
  /** Partial match on the request payload that selects this rule. */
  when?: Record<string, unknown>;
  /** Payload of the CALLRESULT the CSMS must answer with. */
  respond: Record<string, unknown>;
  note?: string;
}

export interface CsmsSimulatorStep {
  /** Control-plane command (e.g. `ev_plug_in`, `start_transaction`). */
  command: string;
  params?: Record<string, unknown>;
  /** Node the step unblocks, when there is one. */
  node?: string;
  note?: string;
}

/** Outcome of evaluating one {@link AssertionSpec} against a run's transcript. */
export type AssertionStatus = "passed" | "failed" | "skipped" | "blocked";

export interface AssertionResult {
  id: string;
  type: AssertionType;
  status: AssertionStatus;
  description: string;
  /** Explanation of what was/wasn't found; set on failure. */
  detail?: string;
  /** How this assertion failure affects the verdict. */
  severity: AssertionSeverity;
  /**
   * #240: transcript frames this result is about — the `seq` (capture-order
   * index) of each frame that satisfied the check (on pass) or triggered the
   * failure (e.g. the unexpected CALL for `ocpp_absent`). Join against
   * {@link ScenarioRunResult.transcript}'s `seq` to point a failed assertion
   * at the relevant messages. Absent when no frame is relevant (e.g. a
   * "never sent" miss, or a malformed spec).
   */
  frameRefs?: number[];
}

/** Overall pass/fail verdict for one scenario run, rolled up from its
 *  {@link AssertionResult}s (see `computeVerdict`). */
export type ScenarioVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

/** Compatibility-only verdict for warning-severity assertions (see `computeVerdictSummary`). */
export type CompatibilityVerdict = "PASS" | "WARNING" | "FAIL" | "SKIPPED";

/**
 * Minimal runtime shape check for a value read from an operator-supplied
 * file (`load_scenario`/`run_scenario_file --file <path>`). The daemon
 * accepts any path the caller names, so without this guard `JSON.parse`
 * output was accepted via a bare `as ScenarioDefinition` cast — any
 * readable JSON file on the host, not just an actual scenario, would be
 * stored and become retrievable through `get_scenario`/`list_scenarios`.
 * This only checks the fields required to identify a scenario; full
 * per-node validation still happens downstream when the scenario runs.
 */
export function isScenarioDefinitionShape(
  value: unknown,
): value is ScenarioDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    (v.targetType === "chargePoint" || v.targetType === "connector") &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges)
  );
}
