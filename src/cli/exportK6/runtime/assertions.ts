// src/cli/exportK6/runtime/assertions.ts
//
// Evaluates a scenario's `AssertionSpec[]` against one VU's captured
// `TranscriptEntry[]` transcript inside the exported k6 load test.
//
// This is a self-contained port of the canonical assertion engine --
// src/cp/application/verification/ScenarioAssertions.ts -- which is the
// authoritative definition of this assertion language's semantics (see its
// doc comments for the full rationale). The SAME scenario JSON must produce
// the SAME pass/fail verdict here as it would in the interactive simulator,
// so every branch below is a deliberate, hand-kept-in-sync mirror of that
// module's logic, adapted to the k6 runtime's flatter data model:
//
//   - ScenarioAssertions.ts walks OCPP wire `Frame[]` (one frame per
//     CALL/CALLRESULT/CALLERROR) and pairs a CALL to its response by
//     OCPP-J uniqueId via `findResponseFor`.
//   - This runtime instead records one `TranscriptEntry` per CALL, with its
//     response folded in directly (see ./types.ts) -- so no separate
//     pairing step is needed, but see the LIMITATION note on
//     `evaluateResponseStatus` below for what that folding costs.
//
// This file is emitted verbatim into export bundles: it must NOT import
// from src/cp/** (not even types), use Node/Bun APIs, or use k6/* imports.
import type { AssertionSpecJson, TranscriptEntry } from "./types";

export interface AssertionOutcome {
  id: string;
  ok: boolean;
  detail: string;
}

export const SUPPORTED_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  "ocpp_sent",
  "ocpp_received",
  "ocpp_absent",
  "response_status",
  "idtag_info_status",
  "payload_match",
  "message_order",
  "message_after",
  "state_transition",
  "no_unexpected",
]);

type Direction = "sent" | "received";

function done(id: string, ok: boolean, detail: string): AssertionOutcome {
  return { id, ok, detail };
}

/**
 * Deep partial match used by `payload_match` -- ported verbatim from
 * ScenarioAssertions.ts's `deepPartialMatch`. Every key in `subset` must be
 * present in `actual` with a deep-equal value: objects match as a subset
 * (extra keys in `actual` are ignored); arrays must be the same length and
 * are compared element-by-element -- pinning an array generally means the
 * whole array, not just a prefix.
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

/**
 * A `TranscriptEntry` "matches" a message_order/message_after reference
 * when its action and direction line up -- direction defaults to "sent"
 * and is always significant. Mirrors ScenarioAssertions.ts's
 * `matchesFrameRef`, minus the `frame.kind === "call"` check: every
 * `TranscriptEntry` already represents exactly one CALL (its response, if
 * any, is folded into the same entry rather than appearing as a separate
 * transcript item), so that check has no equivalent to make here.
 */
function matchesRef(
  entry: TranscriptEntry,
  ref: { action: string; direction?: Direction },
): boolean {
  return (
    entry.action === ref.action && entry.direction === (ref.direction ?? "sent")
  );
}

/**
 * Finds the `occurrence`-th (0-indexed, default 0) transcript entry for
 * `direction` + `action`, in capture order. Mirrors ocpp.ts's `findCall`.
 */
function findEntry(
  t: readonly TranscriptEntry[],
  direction: Direction,
  action: string,
  occurrence = 0,
): TranscriptEntry | undefined {
  let seen = 0;
  for (const e of t) {
    if (e.direction === direction && e.action === action) {
      if (seen === occurrence) return e;
      seen++;
    }
  }
  return undefined;
}

/** Reads `status` or `idTagInfo.status` off a recorded response payload. */
function readStatus(
  response: Record<string, unknown>,
  statusPath: "status" | "idTagInfo.status",
): unknown {
  if (statusPath === "status") return response.status;
  const idTagInfo = response.idTagInfo;
  return typeof idTagInfo === "object" && idTagInfo !== null
    ? (idTagInfo as Record<string, unknown>).status
    : undefined;
}

/**
 * Shared implementation for `response_status` / `idtag_info_status`: finds
 * the `occurrence`-th entry for `action` in `direction` and checks the
 * status at `statusPath` on its recorded response. Mirrors
 * ScenarioAssertions.ts's `evaluateResponseStatus`.
 *
 * LIMITATION (data model gap, not a semantics choice): a `TranscriptEntry`
 * only ever carries a `response` payload when it was recorded for a "sent"
 * CALL -- the CSMS's CALLRESULT/CALLERROR reply to something the CP sent
 * (see ./types.ts and ocppClient.ts's `flush`/`onFrame`). The k6
 * auto-responder's own reply to a "received" CALL (an incoming CSMS
 * request such as RemoteStartTransaction) is never captured anywhere in
 * the transcript, so a spec that resolves to direction="received" --
 * response_status's *default* -- has no data to check here at all, unlike
 * ScenarioAssertions.ts, which pairs ANY CALL with its response via
 * uniqueId regardless of direction. Rather than silently pass or guess at
 * the auto-responder's outcome, this fails loudly with a detail explaining
 * why; see the report for how often this bites (response_status's default
 * direction is exactly this unsupported case).
 */
function evaluateResponseStatus(
  id: string,
  t: readonly TranscriptEntry[],
  action: string,
  expectedStatus: string,
  direction: Direction,
  occurrence: number,
  statusPath: "status" | "idTagInfo.status",
): AssertionOutcome {
  if (direction === "received") {
    return done(
      id,
      false,
      `${action} ${statusPath} for direction=received can't be evaluated: ` +
        "the k6 runtime doesn't record the auto-responder's reply to a " +
        "received CALL in the transcript (only CSMS replies to CP-sent " +
        'CALLs are captured) -- use direction: "sent" or drop this assertion',
    );
  }
  const entry = findEntry(t, direction, action, occurrence);
  if (!entry) {
    return done(
      id,
      false,
      `no ${direction} CALL found for action=${action} (occurrence ${occurrence})`,
    );
  }
  if (entry.errorCode !== undefined) {
    return done(
      id,
      false,
      `expected a response for ${action}, got errorCode=${entry.errorCode}`,
    );
  }
  if (entry.response === undefined) {
    return done(id, false, `no response recorded yet for ${action}`);
  }
  const actual = readStatus(entry.response, statusPath);
  return actual === expectedStatus
    ? done(id, true, `${action} ${statusPath}=${String(actual)}`)
    : done(
        id,
        false,
        `expected ${statusPath}=${expectedStatus}, got ${statusPath}=${String(actual)}`,
      );
}

export function evaluateAssertions(
  specs: readonly AssertionSpecJson[],
  transcript: readonly TranscriptEntry[],
  finalStatus: string,
): AssertionOutcome[] {
  return specs.map((spec) => evaluate(spec, transcript, finalStatus));
}

function evaluate(
  spec: AssertionSpecJson,
  t: readonly TranscriptEntry[],
  // Kept for API compatibility with render.ts's call site
  // (`evaluateAssertions(specs, cp.transcript(), cp.status())`). The
  // canonical engine has no equivalent input -- state_transition (the only
  // type that could plausibly want it) is defined purely in terms of sent
  // StatusNotification transcript entries, so this stays unused here
  // rather than reintroducing a check canonical doesn't have.
  _finalStatus: string,
): AssertionOutcome {
  switch (spec.type) {
    case "ocpp_sent": {
      if (!spec.action) {
        return done(spec.id, false, "ocpp_sent requires 'action'");
      }
      const found = findEntry(t, "sent", spec.action) !== undefined;
      return done(spec.id, found, `${spec.action}.req sent: ${found}`);
    }

    case "ocpp_received": {
      if (!spec.action) {
        return done(spec.id, false, "ocpp_received requires 'action'");
      }
      const found = findEntry(t, "received", spec.action) !== undefined;
      return done(spec.id, found, `${spec.action}.req received: ${found}`);
    }

    case "ocpp_absent": {
      if (!spec.action) {
        return done(spec.id, false, "ocpp_absent requires 'action'");
      }
      const direction = spec.direction ?? "sent";
      const found = findEntry(t, direction, spec.action) !== undefined;
      return done(
        spec.id,
        !found,
        found
          ? `unexpected ${direction} CALL found for ${spec.action}`
          : `no ${direction} CALL found for ${spec.action}`,
      );
    }

    case "response_status": {
      if (!spec.action || !spec.status) {
        return done(
          spec.id,
          false,
          "response_status requires 'action' and 'status'",
        );
      }
      return evaluateResponseStatus(
        spec.id,
        t,
        spec.action,
        spec.status,
        spec.direction ?? "received",
        spec.occurrence ?? 0,
        "status",
      );
    }

    case "idtag_info_status": {
      if (!spec.action || !spec.status) {
        return done(
          spec.id,
          false,
          "idtag_info_status requires 'action' and 'status'",
        );
      }
      return evaluateResponseStatus(
        spec.id,
        t,
        spec.action,
        spec.status,
        spec.direction ?? "sent",
        spec.occurrence ?? 0,
        "idTagInfo.status",
      );
    }

    case "payload_match": {
      if (!spec.action || !spec.payload) {
        return done(
          spec.id,
          false,
          "payload_match requires 'action' and 'payload'",
        );
      }
      const direction = spec.direction ?? "sent";
      const occurrence = spec.occurrence ?? 0;
      const entry = findEntry(t, direction, spec.action, occurrence);
      if (!entry) {
        return done(
          spec.id,
          false,
          `no ${direction} CALL found for action=${spec.action} (occurrence ${occurrence})`,
        );
      }
      const ok = deepPartialMatch(spec.payload, entry.payload);
      return done(
        spec.id,
        ok,
        `${spec.action} payload ${ok ? "matches" : "did not match"} expected subset`,
      );
    }

    case "message_order": {
      if (!spec.before || !spec.after) {
        return done(
          spec.id,
          false,
          "message_order requires 'before' and 'after'",
        );
      }
      const { before, after } = spec;
      const beforeIndex = t.findIndex((e) => matchesRef(e, before));
      const afterIndex = t.findIndex((e) => matchesRef(e, after));
      if (beforeIndex === -1 || afterIndex === -1) {
        return done(
          spec.id,
          false,
          `one or both messages not found (before=${before.action} found=${beforeIndex !== -1}, after=${after.action} found=${afterIndex !== -1})`,
        );
      }
      return done(
        spec.id,
        beforeIndex < afterIndex,
        `${before.action}@${beforeIndex} vs ${after.action}@${afterIndex}`,
      );
    }

    case "message_after": {
      if (!spec.before || !spec.after) {
        return done(
          spec.id,
          false,
          "message_after requires 'before' and 'after'",
        );
      }
      const { before, after } = spec;
      let lastBeforeIndex = -1;
      t.forEach((e, i) => {
        if (matchesRef(e, before)) lastBeforeIndex = i;
      });
      if (lastBeforeIndex === -1) {
        return done(
          spec.id,
          false,
          `reference message not found: ${before.action}`,
        );
      }
      const found = t
        .slice(lastBeforeIndex + 1)
        .some((e) => matchesRef(e, after));
      return done(
        spec.id,
        found,
        found
          ? `${after.action} found after ${before.action}@${lastBeforeIndex}`
          : `${after.action} not found after ${before.action}@${lastBeforeIndex}`,
      );
    }

    case "state_transition": {
      if (!spec.targetStatus) {
        return done(spec.id, false, "state_transition requires 'targetStatus'");
      }
      const matched = t.some(
        (e) =>
          e.direction === "sent" &&
          e.action === "StatusNotification" &&
          e.payload.status === spec.targetStatus,
      );
      return done(
        spec.id,
        matched,
        `StatusNotification -> ${spec.targetStatus} reached: ${matched}`,
      );
    }

    case "no_unexpected": {
      if (!spec.actions || spec.actions.length === 0) {
        return done(
          spec.id,
          false,
          "no_unexpected requires a non-empty 'actions' list",
        );
      }
      const found = spec.actions.filter(
        (action) => findEntry(t, "sent", action) !== undefined,
      );
      return done(
        spec.id,
        found.length === 0,
        found.length === 0
          ? `none of [${spec.actions.join(", ")}] were sent`
          : `unexpected sent CALL(s) found: ${found.join(", ")}`,
      );
    }

    default:
      return done(spec.id, false, `unsupported assertion type "${spec.type}"`);
  }
}
