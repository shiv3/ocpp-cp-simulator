/**
 * Stateful CALL/CALLRESULT/CALLERROR action correlation for the OCPP trace
 * format (issue #188). Extracted from {@link ./logEntryToTrace}'s
 * `logLinesToTrace` so a live producer (the CLI's TraceWriter) can back-fill
 * actions one record at a time as a run streams past, instead of only over a
 * pre-collected batch.
 */

import type { OcppTraceRecord } from "./OcppTraceRecord";

/** Correlation key scoped per charge point: a batch/stream can interleave
 *  multiple CPs (e.g. the daemon's JSON log), and two CPs may reuse the same
 *  messageId. The JSON tuple stays unambiguous whatever the cpId/messageId
 *  contain. */
function correlationKey(record: OcppTraceRecord): string {
  return JSON.stringify([record.chargePointId ?? "", record.messageId]);
}

export class TraceCorrelator {
  private readonly actionByKey = new Map<string, string>();

  /** Record a CALL's action / back-fill a CALLRESULT/CALLERROR action, in place. Returns the same record. */
  observe(record: OcppTraceRecord): OcppTraceRecord {
    if (record.messageId === undefined) return record;
    const key = correlationKey(record);
    if (record.action) {
      this.actionByKey.set(key, record.action);
    } else {
      const resolved = this.actionByKey.get(key);
      if (resolved) record.action = resolved;
    }
    return record;
  }
}
