/**
 * ScenarioAssertions.ts -- declarative assertion engine for scenario runs
 * (#179 Phase 2b). Evaluates a scenario's `AssertionSpec[]`
 * (src/cp/application/scenario/ScenarioTypes.ts) against the OCPP wire
 * `Frame[]` captured for one run (see TranscriptBuffer) and rolls the
 * per-assertion results up into an overall {@link ScenarioVerdict}.
 *
 * Mirrors assert.ts's check semantics (uniqueId-correlated response
 * matching via findResponseFor, occurrence-indexed findCall, ...) but
 * returns a result per spec instead of pushing into an AssertRecorder --
 * a scenario run has no interactive test-runner context to record into,
 * and Phase 3 wants a serializable per-run report.
 */

import {
  findAllCalls,
  findCall,
  findResponseFor,
  type CallFrame,
  type Direction,
  type Frame,
} from "./ocpp";
import type {
  AssertionResult,
  AssertionSpec,
  AssertionStatus,
  ScenarioVerdict,
  CompatibilityVerdict,
} from "../scenario/ScenarioTypes";
import {
  redactSensitiveText,
  redactSensitiveValue,
} from "../../shared/redaction";

/**
 * Deep partial match used by `payload_match`: every key in `subset` must be
 * present in `actual` with a deep-equal value. Objects are matched as a
 * subset (extra keys in `actual` are ignored); arrays are compared
 * element-by-element and must be the same length -- an assertion author
 * pinning an array generally means the whole array, not just a prefix.
 */
function deepPartialMatch(subset: unknown, actual: unknown): boolean {
  if (subset === actual) return true;
  if (
    typeof subset !== "object" ||
    subset === null ||
    typeof actual !== "object" ||
    actual === null
  ) {
    return false;
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual) || subset.length !== actual.length) {
      return false;
    }
    return subset.every((item, i) => deepPartialMatch(item, actual[i]));
  }
  if (Array.isArray(actual)) return false;
  const subsetObj = subset as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  return Object.keys(subsetObj).every((key) =>
    deepPartialMatch(subsetObj[key], actualObj[key]),
  );
}

/** A frame "matches" a message_order/message_after reference when it's a
 *  CALL for the given action in the given direction (default "sent"). */
function matchesFrameRef(
  frame: Frame,
  ref: { action: string; direction?: Direction },
): boolean {
  return (
    frame.kind === "call" &&
    frame.action === ref.action &&
    frame.direction === (ref.direction ?? "sent")
  );
}

function makeResult(
  spec: AssertionSpec,
  status: AssertionStatus,
  defaultDescription: string,
  detail?: string,
  frameRefs?: number[],
): AssertionResult {
  return {
    id: spec.id,
    type: spec.type,
    status,
    description: spec.description ?? defaultDescription,
    detail,
    severity: spec.severity ?? "failure",
    // #240: only attach when a frame is actually relevant, so a "never sent"
    // miss or a malformed spec stays free of an empty array.
    ...(frameRefs && frameRefs.length > 0 ? { frameRefs } : {}),
  };
}

/** Capture-order indices (transcript `seq`) of the given frames, skipping any
 *  that aren't present. #240: lets an assertion result point at the exact
 *  transcript entries it matched. */
function frameIndices(
  frames: readonly Frame[],
  ...found: ReadonlyArray<Frame | null | undefined>
): number[] {
  const out: number[] = [];
  for (const frame of found) {
    if (!frame) continue;
    const i = frames.indexOf(frame);
    if (i >= 0) out.push(i);
  }
  return out;
}

/** Shared implementation for `response_status` / `idtag_info_status`:
 *  find the `occurrence`-th CALL for `action` in `direction`, its response
 *  paired by OCPP-J uniqueId, and check the status at `statusPath`. */
function evaluateResponseStatus(
  spec: AssertionSpec,
  frames: readonly Frame[],
  action: string,
  expectedStatus: string,
  direction: Direction,
  occurrence: number,
  statusPath: "status" | "idTagInfo.status",
): AssertionResult {
  const description =
    statusPath === "status"
      ? `${action} -> status ${expectedStatus}`
      : `${action} -> idTagInfo.status ${expectedStatus}`;

  const call = findCall(frames, direction, action, occurrence);
  if (!call) {
    return makeResult(
      spec,
      "failed",
      description,
      `no ${direction} CALL found for action=${action} (occurrence ${occurrence})`,
    );
  }
  const response = findResponseFor(frames, call);
  if (!response) {
    return makeResult(
      spec,
      "failed",
      description,
      `no response frame found for uniqueId=${call.uniqueId} (${action})`,
      frameIndices(frames, call),
    );
  }
  const refs = frameIndices(frames, call, response);
  if (response.kind === "callerror") {
    return makeResult(
      spec,
      "failed",
      description,
      `expected CALLRESULT, got CALLERROR ${response.errorCode}: ${response.errorDescription}`,
      refs,
    );
  }

  const actualStatus =
    statusPath === "status"
      ? (response.payload as { status?: unknown } | null)?.status
      : (response.payload as { idTagInfo?: { status?: unknown } } | null)
          ?.idTagInfo?.status;
  if (actualStatus === expectedStatus) {
    return makeResult(spec, "passed", description, undefined, refs);
  }
  return makeResult(
    spec,
    "failed",
    description,
    `expected ${statusPath}=${expectedStatus}, got ${statusPath}=${String(actualStatus)} (uniqueId=${call.uniqueId})`,
    refs,
  );
}

/** Evaluates a single {@link AssertionSpec}. A malformed spec (missing a
 *  field its `type` requires) never throws -- it resolves to a "failed"
 *  result with an explanatory detail, since a scenario JSON hand-edited by
 *  an operator is untrusted input. */
function evaluateOne(
  spec: AssertionSpec,
  frames: readonly Frame[],
): AssertionResult {
  const fallbackDescription = spec.description ?? `assertion ${spec.id}`;

  switch (spec.type) {
    case "ocpp_sent": {
      if (!spec.action) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "ocpp_sent requires 'action'",
        );
      }
      const description = `${spec.action}.req sent`;
      const call = findCall(frames, "sent", spec.action);
      return call
        ? makeResult(
            spec,
            "passed",
            description,
            undefined,
            frameIndices(frames, call),
          )
        : makeResult(
            spec,
            "failed",
            description,
            `no Sent CALL found for action=${spec.action}`,
          );
    }

    case "ocpp_received": {
      if (!spec.action) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "ocpp_received requires 'action'",
        );
      }
      const description = `${spec.action}.req received`;
      const call = findCall(frames, "received", spec.action);
      return call
        ? makeResult(
            spec,
            "passed",
            description,
            undefined,
            frameIndices(frames, call),
          )
        : makeResult(
            spec,
            "failed",
            description,
            `no Received CALL found for action=${spec.action}`,
          );
    }

    case "ocpp_absent": {
      if (!spec.action) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "ocpp_absent requires 'action'",
        );
      }
      const direction = spec.direction ?? "sent";
      const description = `no ${spec.action} ${direction}`;
      const call = findCall(frames, direction, spec.action);
      return call
        ? makeResult(
            spec,
            "failed",
            description,
            `unexpected ${direction} CALL found: ${call.raw}`,
            frameIndices(frames, call),
          )
        : makeResult(spec, "passed", description);
    }

    case "response_status": {
      if (!spec.action || !spec.status) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "response_status requires 'action' and 'status'",
        );
      }
      return evaluateResponseStatus(
        spec,
        frames,
        spec.action,
        spec.status,
        spec.direction ?? "received",
        spec.occurrence ?? 0,
        "status",
      );
    }

    case "idtag_info_status": {
      if (!spec.action || !spec.status) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "idtag_info_status requires 'action' and 'status'",
        );
      }
      return evaluateResponseStatus(
        spec,
        frames,
        spec.action,
        spec.status,
        spec.direction ?? "sent",
        spec.occurrence ?? 0,
        "idTagInfo.status",
      );
    }

    case "payload_match": {
      if (!spec.action || !spec.payload) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "payload_match requires 'action' and 'payload'",
        );
      }
      const direction = spec.direction ?? "sent";
      const occurrence = spec.occurrence ?? 0;
      const description = `${spec.action} payload matches`;
      const call = findCall(frames, direction, spec.action, occurrence);
      if (!call) {
        return makeResult(
          spec,
          "failed",
          description,
          `no ${direction} CALL found for action=${spec.action} (occurrence ${occurrence})`,
        );
      }
      const payloadRefs = frameIndices(frames, call);
      return deepPartialMatch(spec.payload, call.payload)
        ? makeResult(spec, "passed", description, undefined, payloadRefs)
        : makeResult(
            spec,
            "failed",
            description,
            `payload for ${spec.action} (uniqueId=${call.uniqueId}) did not match expected subset`,
            payloadRefs,
          );
    }

    case "message_order": {
      if (!spec.before || !spec.after) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "message_order requires 'before' and 'after'",
        );
      }
      const { before, after } = spec;
      const description = `${before.action} before ${after.action}`;
      const beforeIndex = frames.findIndex((f) => matchesFrameRef(f, before));
      const afterIndex = frames.findIndex((f) => matchesFrameRef(f, after));
      if (beforeIndex === -1 || afterIndex === -1) {
        return makeResult(
          spec,
          "failed",
          description,
          `one or both frames not found (before=${before.action} found=${beforeIndex !== -1}, after=${after.action} found=${afterIndex !== -1})`,
        );
      }
      const orderRefs = [beforeIndex, afterIndex];
      return beforeIndex < afterIndex
        ? makeResult(spec, "passed", description, undefined, orderRefs)
        : makeResult(
            spec,
            "failed",
            description,
            `before (frame ${beforeIndex}) did not precede after (frame ${afterIndex})`,
            orderRefs,
          );
    }

    case "message_after": {
      if (!spec.before || !spec.after) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "message_after requires 'before' and 'after'",
        );
      }
      const { before, after } = spec;
      const description = `${after.action} after ${before.action}`;
      let lastBeforeIndex = -1;
      frames.forEach((f, i) => {
        if (matchesFrameRef(f, before)) lastBeforeIndex = i;
      });
      if (lastBeforeIndex === -1) {
        return makeResult(
          spec,
          "failed",
          description,
          `reference frame not found: ${before.action}`,
        );
      }
      const afterRelative = frames
        .slice(lastBeforeIndex + 1)
        .findIndex((f) => matchesFrameRef(f, after));
      return afterRelative !== -1
        ? makeResult(spec, "passed", description, undefined, [
            lastBeforeIndex,
            lastBeforeIndex + 1 + afterRelative,
          ])
        : makeResult(
            spec,
            "failed",
            description,
            `${after.action} not found after frame ${lastBeforeIndex} (${before.action})`,
            [lastBeforeIndex],
          );
    }

    case "state_transition": {
      if (!spec.targetStatus) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "state_transition requires 'targetStatus'",
        );
      }
      const description = `StatusNotification -> ${spec.targetStatus}`;
      const matched = findAllCalls(frames, "sent", "StatusNotification").find(
        (f) =>
          (f.payload as { status?: unknown } | null)?.status ===
          spec.targetStatus,
      );
      return matched
        ? makeResult(
            spec,
            "passed",
            description,
            undefined,
            frameIndices(frames, matched),
          )
        : makeResult(
            spec,
            "failed",
            description,
            `no sent StatusNotification found with status=${spec.targetStatus}`,
          );
    }

    case "no_unexpected": {
      if (!spec.actions || spec.actions.length === 0) {
        return makeResult(
          spec,
          "failed",
          fallbackDescription,
          "no_unexpected requires a non-empty 'actions' list",
        );
      }
      const description = `no unexpected: ${spec.actions.join(", ")}`;
      // Every sent CALL for a forbidden action, not just the first per action —
      // a repeated offender must reference all of its frames (#240).
      const forbidden = new Set(spec.actions);
      const foundFrames = frames.filter(
        (frame): frame is CallFrame =>
          frame.kind === "call" &&
          frame.direction === "sent" &&
          forbidden.has(frame.action),
      );
      return foundFrames.length === 0
        ? makeResult(spec, "passed", description)
        : makeResult(
            spec,
            "failed",
            description,
            `unexpected sent CALL(s) found: ${[
              ...new Set(foundFrames.map((call) => call.action)),
            ].join(", ")}`,
            frameIndices(frames, ...foundFrames),
          );
    }

    default:
      // Unknown `type` string (e.g. hand-edited scenario JSON from a newer
      // build) -- fail loudly instead of silently skipping.
      return makeResult(
        spec,
        "failed",
        fallbackDescription,
        `unknown assertion type: ${String(spec.type)}`,
      );
  }
}

/** Evaluates every {@link AssertionSpec} against the run's captured
 *  transcript, one result per spec, in declaration order. */
export function evaluateAssertions(
  specs: AssertionSpec[],
  frames: readonly Frame[],
): AssertionResult[] {
  return specs.map((spec) => evaluateOne(spec, frames));
}

/**
 * #179 Phase 3: one captured wire {@link Frame} flattened into the
 * JSON-serializable shape used by the `scenario_report` transcript. A pure
 * structural mapping -- no redaction here, see {@link redactTranscriptEntry}
 * -- so this stays trivially testable against exact Frame fixtures.
 */
export interface TranscriptEntry {
  seq: number;
  ts: string;
  direction: Direction;
  kind: "call" | "callresult" | "callerror";
  uniqueId: string;
  action?: string;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
}

/** Connector state captured at the start/end of a scenario run -- the
 *  `initialState` / `finalState` fields of {@link ScenarioRunResult}. */
export interface ScenarioStateSnapshot {
  connectorStatus: string;
  meterValue: number;
  transactionId: number | null;
}

/**
 * Maps a captured {@link Frame} to its flat {@link TranscriptEntry} shape.
 * `seq` is the frame's position in capture order -- the caller (typically
 * `frames.map((f, i) => frameToTranscriptEntry(f, i))`) supplies it, since
 * TranscriptBuffer's public `frames` getter is typed as plain `Frame[]`
 * (it can't expose TranscriptFrame's own `seq` without widening the type
 * evaluateAssertions and every other Frame[] consumer already relies on).
 */
export function frameToTranscriptEntry(
  frame: Frame,
  seq: number,
): TranscriptEntry {
  const shared = {
    seq,
    ts: frame.timestamp,
    direction: frame.direction,
    uniqueId: frame.uniqueId,
  };

  switch (frame.kind) {
    case "call":
      return {
        ...shared,
        kind: "call",
        action: frame.action,
        payload: frame.payload,
      };
    case "callresult":
      return { ...shared, kind: "callresult", payload: frame.payload };
    case "callerror":
      return {
        ...shared,
        kind: "callerror",
        errorCode: frame.errorCode,
        errorDescription: frame.errorDescription,
      };
    default: {
      // Exhaustiveness guard: Frame is a closed union, so this only fires
      // if a new Frame kind is added to ocpp.ts without updating this map.
      const neverFrame: never = frame;
      throw new Error(
        `frameToTranscriptEntry: unhandled frame kind ${String((neverFrame as Frame).kind)}`,
      );
    }
  }
}

/**
 * Redacts a {@link TranscriptEntry} (returns a new object; the input is
 * never mutated) before it can flow into a `scenario_report` RPC response.
 * Transcript payloads are raw OCPP-J CALL/CALLRESULT bodies and can carry
 * auth material (AuthorizationKey, password, ...) -- see
 * src/cp/shared/redaction.ts for exactly what `redactSensitiveValue`
 * strips. `errorDescription` is redacted too since a CALLERROR's
 * description is a free-text string that could echo back request content.
 */
export function redactTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  if (entry.kind === "callerror") {
    return {
      ...entry,
      errorDescription:
        entry.errorDescription !== undefined
          ? redactSensitiveText(entry.errorDescription)
          : entry.errorDescription,
    };
  }
  return { ...entry, payload: redactSensitiveValue(entry.payload) };
}

/**
 * Full per-run report (#179 Phase 3), stored by CLIChargePointService once
 * a scenario run ends and surfaced over RPC as `scenario_report`.
 * `schemaVersion` is pinned to `1` so a future breaking change to this
 * shape can be detected by clients instead of silently misparsed.
 * `templateId` / `profile` are omitted (left undefined) rather than
 * invented -- ScenarioDefinition doesn't carry either field today.
 */
export interface ScenarioRunResult {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  templateId?: string;
  scenarioName?: string;
  profile?: string;
  cpId: string;
  connectorId: number;
  simulatorVersion: string;
  ocppVersion: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  executionState: "completed" | "error";
  /** Overall verdict combining conformance and compatibility axes. */
  verdict: ScenarioVerdict;
  /** Verdict for failure-severity assertions only (conformance). */
  conformanceVerdict: ScenarioVerdict;
  /** Verdict for warning-severity assertions only (compatibility). */
  compatibilityVerdict: CompatibilityVerdict;
  /** Whether strict mode was enabled (promotes warnings to failures). */
  strict: boolean;
  assertions: AssertionResult[];
  transcript: TranscriptEntry[];
  errors: string[];
  timeout: { nodeId: string; expectation?: unknown } | null;
  initialState: ScenarioStateSnapshot;
  finalState: ScenarioStateSnapshot;
}

export interface ComputeVerdictOptions {
  /** Whether the scenario run ended normally or via the executor's error
   *  path. "error" forces a BLOCKED verdict -- an errored run can't be
   *  trusted to have reached a verifiable state. */
  executionState: "completed" | "error";
  /** True when the run was stopped while parked on a waiting node (a
   *  timeout or a manual stop mid-wait) rather than reaching `end`
   *  naturally. Also forces BLOCKED. */
  blocked?: boolean;
}

/**
 * Two-axis verdict from {@link computeVerdictSummary}: separates conformance
 * (failure-severity assertions) from compatibility (warning-severity assertions).
 */
export interface VerdictSummary {
  /** Overall verdict combining both axes. */
  verdict: ScenarioVerdict;
  /** Verdict for failure-severity assertions only (conformance). */
  conformanceVerdict: ScenarioVerdict;
  /** Verdict for warning-severity assertions only (compatibility). */
  compatibilityVerdict: CompatibilityVerdict;
  /** Whether strict mode was enabled (promotes warnings to failures). */
  strict: boolean;
}

/**
 * Rolls one severity axis' results up into a {@link ScenarioVerdict}, with the
 * same priority order computeVerdict has used since #179 Phase 2b:
 *
 * 1. SKIPPED -- the axis has no assertions, or every one resolved "skipped".
 * 2. BLOCKED -- the run errored or was blocked (outranks FAIL: a run that
 *    never reached a verifiable state shouldn't be reported as a clean
 *    failure).
 * 3. FAIL -- at least one assertion failed.
 * 4. PASS -- every assertion passed.
 */
function computeSingleAxisVerdict(
  results: AssertionResult[],
  opts: Pick<ComputeVerdictOptions, "executionState" | "blocked">,
): ScenarioVerdict {
  if (
    results.length === 0 ||
    results.every((r) => r.status === "skipped" || r.status === "blocked")
  ) {
    return "SKIPPED";
  }
  if (opts.executionState === "error" || opts.blocked === true) {
    return "BLOCKED";
  }
  if (results.some((r) => r.status === "failed")) {
    return "FAIL";
  }
  return "PASS";
}

/**
 * Two-axis verdict (#247): partitions results by {@link AssertionSeverity}.
 *
 * - conformanceVerdict: failure-severity assertions only, ranked exactly like
 *   the legacy computeVerdict.
 * - compatibilityVerdict: warning-severity assertions only. SKIPPED when the
 *   axis has no assertions or none produced a pass/fail outcome; WARNING when
 *   one failed (FAIL instead under strict); PASS otherwise. Warnings mark
 *   behavior that is legal OCPP but observed to trip picky peers (e.g. OCTT),
 *   so they never fail a non-strict run.
 * - verdict: overall. Keeps the legacy priority (SKIPPED for an
 *   assertion-less run outranks BLOCKED), fails on conformance failures, and
 *   fails on compatibility findings only under strict.
 */
export function computeVerdictSummary(
  results: AssertionResult[],
  opts: ComputeVerdictOptions & { strict?: boolean },
): VerdictSummary {
  const strict = opts.strict ?? false;
  const conformanceResults = results.filter((r) => r.severity === "failure");
  const compatibilityResults = results.filter((r) => r.severity === "warning");

  const conformanceVerdict = computeSingleAxisVerdict(conformanceResults, opts);

  let compatibilityVerdict: CompatibilityVerdict;
  if (
    compatibilityResults.every(
      (r) => r.status === "skipped" || r.status === "blocked",
    )
  ) {
    compatibilityVerdict = "SKIPPED";
  } else if (compatibilityResults.some((r) => r.status === "failed")) {
    compatibilityVerdict = strict ? "FAIL" : "WARNING";
  } else {
    compatibilityVerdict = "PASS";
  }

  let verdict: ScenarioVerdict;
  if (results.length === 0 || results.every((r) => r.status === "skipped")) {
    verdict = "SKIPPED";
  } else if (opts.executionState === "error" || opts.blocked === true) {
    verdict = "BLOCKED";
  } else if (
    conformanceVerdict === "FAIL" ||
    (strict && compatibilityVerdict === "FAIL")
  ) {
    verdict = "FAIL";
  } else {
    verdict = "PASS";
  }

  return { verdict, conformanceVerdict, compatibilityVerdict, strict };
}

/**
 * Rolls a run's per-assertion results up into one {@link ScenarioVerdict}:
 *
 * 1. SKIPPED -- no assertions were declared, or every declared assertion
 *    resolved to "skipped".
 * 2. BLOCKED -- the run errored or was blocked (outranks FAIL: a run that
 *    never reached a verifiable state shouldn't be reported as a clean
 *    failure).
 * 3. FAIL -- at least one assertion failed.
 * 4. PASS -- every assertion passed.
 *
 * NOTE: This function provides backward compatibility for legacy callers.
 * It uses strict=true semantics internally, which means warning-severity
 * assertions are treated as failures. For new code, use computeVerdictSummary
 * to get the two-axis verdict and control strictness explicitly.
 */
export function computeVerdict(
  results: AssertionResult[],
  opts: ComputeVerdictOptions,
): ScenarioVerdict {
  return computeVerdictSummary(results, { ...opts, strict: true }).verdict;
}
