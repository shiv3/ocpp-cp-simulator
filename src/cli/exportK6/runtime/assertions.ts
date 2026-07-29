// src/cli/exportK6/runtime/assertions.ts
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
  finalStatus: string,
): AssertionOutcome {
  const done = (ok: boolean, detail: string): AssertionOutcome => ({
    id: spec.id,
    ok,
    detail,
  });
  const matches = (e: TranscriptEntry): boolean =>
    (spec.action === undefined || e.action === spec.action) &&
    (spec.direction === undefined || e.direction === spec.direction);

  switch (spec.type) {
    case "ocpp_sent": {
      const n = t.filter(
        (e) => e.direction === "sent" && e.action === spec.action,
      ).length;
      const want = spec.occurrence ?? 1;
      return done(
        n >= want,
        `${spec.action} sent ${n} time(s), wanted >= ${want}`,
      );
    }
    case "ocpp_received": {
      const n = t.filter(
        (e) => e.direction === "received" && e.action === spec.action,
      ).length;
      const want = spec.occurrence ?? 1;
      return done(
        n >= want,
        `${spec.action} received ${n} time(s), wanted >= ${want}`,
      );
    }
    case "ocpp_absent": {
      const n = t.filter(matches).length;
      return done(n === 0, `${spec.action} seen ${n} time(s), wanted 0`);
    }
    case "response_status": {
      const e = t.find(
        (x) => x.direction === "sent" && x.action === spec.action,
      );
      const got = e?.response?.status;
      return done(
        got === spec.status,
        `${spec.action} response.status=${String(got)}`,
      );
    }
    case "idtag_info_status": {
      const e = t.find(
        (x) => x.direction === "sent" && x.action === spec.action,
      );
      const info = e?.response?.idTagInfo as
        Record<string, unknown> | undefined;
      return done(
        info?.status === spec.status,
        `${spec.action} idTagInfo.status=${String(info?.status)}`,
      );
    }
    case "payload_match": {
      const wanted = spec.payload ?? {};
      const hit = t.some(
        (e) =>
          matches(e) &&
          Object.entries(wanted).every(
            ([k, v]) => JSON.stringify(e.payload[k]) === JSON.stringify(v),
          ),
      );
      return done(
        hit,
        `${spec.action ?? "message"} payload subset match: ${hit}`,
      );
    }
    case "message_order": {
      const wanted = spec.actions ?? [];
      let i = 0;
      for (const e of t) {
        if (i < wanted.length && e.action === wanted[i]) i++;
      }
      return done(
        i === wanted.length,
        `matched ${i}/${wanted.length} in order`,
      );
    }
    case "message_after": {
      const anchor = spec.after ?? spec.before;
      if (!spec.action || !anchor) return done(false, "missing action/anchor");
      const anchorIdx = t.findIndex((e) => e.action === anchor.action);
      const actionIdx = t.findIndex((e) => e.action === spec.action);
      if (anchorIdx < 0 || actionIdx < 0)
        return done(false, "message(s) not found");
      const ok = spec.after ? actionIdx > anchorIdx : actionIdx < anchorIdx;
      return done(
        ok,
        `${spec.action}@${actionIdx} vs ${anchor.action}@${anchorIdx}`,
      );
    }
    case "state_transition": {
      const seen = t.some(
        (e) =>
          e.direction === "sent" &&
          e.action === "StatusNotification" &&
          e.payload.status === spec.targetStatus,
      );
      const ok = seen || finalStatus === spec.targetStatus;
      return done(ok, `status ${spec.targetStatus} reached: ${ok}`);
    }
    case "no_unexpected": {
      const errors = t.filter((e) => e.errorCode !== undefined);
      return done(errors.length === 0, `${errors.length} CALLERROR(s)`);
    }
    default:
      return done(false, `unsupported assertion type "${spec.type}"`);
  }
}
