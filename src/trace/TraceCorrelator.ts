/**
 * Stateful CALL/CALLRESULT/CALLERROR action correlation for the OCPP trace
 * format (issue #188). Extracted from {@link ./logEntryToTrace}'s
 * `logLinesToTrace` so a live producer (the CLI's TraceWriter) can back-fill
 * actions one record at a time as a run streams past, instead of only over a
 * pre-collected batch.
 */

import type { OcppTraceRecord } from "./OcppTraceRecord";

/** Cap on pending CALL entries awaiting a response. Pending CALLs that never
 * receive a response must not grow unboundedly in a long daemon run. */
export const MAX_PENDING_CORRELATIONS = 10_000;

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
      // Evict the oldest entry if we're at the cap before adding a new one
      if (this.actionByKey.size >= MAX_PENDING_CORRELATIONS) {
        const oldestKey = this.actionByKey.keys().next().value;
        this.actionByKey.delete(oldestKey);
      }
      this.actionByKey.set(key, record.action);
    } else {
      const resolved = this.actionByKey.get(key);
      if (resolved) {
        record.action = resolved;
        // OCPP-J has exactly one response per CALL: evict on consumption
        // so a long-running daemon's actionByKey map doesn't grow one
        // entry per unique messageId forever.
        this.actionByKey.delete(key);
      }
    }
    return record;
  }
}
