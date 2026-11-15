/**
 * Stateful CALL/CALLRESULT/CALLERROR action correlation for the OCPP trace
 * format (issue #188). Extracted from {@link ./logEntryToTrace}'s
 * `logLinesToTrace` so a live producer (the CLI's TraceWriter) can back-fill
 * actions one record at a time as a run streams past, instead of only over a
 * pre-collected batch.
 *
 * It back-fills `connectorId` the same way (#999): a CALLRESULT/CALLERROR
 * inherits the connector of the CALL it answers, and a 1.6
 * StopTransaction / RemoteStopTransaction CALL, which only carries a
 * `transactionId`, gets the connector of the StartTransaction whose
 * CALLRESULT returned that `transactionId` — the rules `analyze`'s
 * connector split applies after the fact (apps/cli/src/analyze/splitTrace.ts).
 */

import type { TraceRecord } from "@open-ocpp-trace/core";
import { insertConnectorId, payloadTransactionId } from "./connectorId";

/** Cap on pending CALL entries awaiting a response, and on learned
 * transactions. Pending CALLs that never receive a response must not grow
 * unboundedly in a long daemon run. */
export const MAX_PENDING_CORRELATIONS = 10_000;

/** 1.6 CALLs that only carry `transactionId`; their connector comes from the
 *  StartTransaction exchange. */
const TRANSACTION_ID_ACTIONS = new Set([
  "StopTransaction",
  "RemoteStopTransaction",
]);

/** Correlation key scoped per charge point: a batch/stream can interleave
 *  multiple CPs (e.g. the daemon's JSON log), and two CPs may reuse the same
 *  messageId. The JSON tuple stays unambiguous whatever the cpId/messageId
 *  contain. */
function correlationKey(record: TraceRecord): string {
  return JSON.stringify([record.chargePointId ?? "", record.messageId]);
}

function transactionKey(record: TraceRecord, transactionId: number): string {
  return JSON.stringify([record.chargePointId ?? "", transactionId]);
}

interface PendingCall {
  action: string;
  connectorId?: number;
}

/** Set `key` in an insertion-ordered map capped at
 *  {@link MAX_PENDING_CORRELATIONS}, evicting the oldest entry first. */
function setCapped<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_PENDING_CORRELATIONS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

export class TraceCorrelator {
  private readonly pendingByKey = new Map<string, PendingCall>();
  private readonly connectorByTransaction = new Map<string, number>();

  /** Record a CALL's action and connector / back-fill a CALLRESULT/CALLERROR
   *  action and connector, in place. Returns the same record. */
  observe(record: TraceRecord): TraceRecord {
    if (record.messageId === undefined) return record;
    const key = correlationKey(record);
    if (record.action) {
      if (
        record.connectorId === undefined &&
        TRANSACTION_ID_ACTIONS.has(record.action)
      ) {
        const transactionId = payloadTransactionId(record.payload);
        const connectorId =
          transactionId === undefined
            ? undefined
            : this.connectorByTransaction.get(
                transactionKey(record, transactionId),
              );
        if (connectorId !== undefined) insertConnectorId(record, connectorId);
      }
      setCapped(this.pendingByKey, key, {
        action: record.action,
        ...(record.connectorId !== undefined
          ? { connectorId: record.connectorId }
          : {}),
      });
    } else {
      const pending = this.pendingByKey.get(key);
      if (pending) {
        record.action = pending.action;
        if (
          pending.connectorId !== undefined &&
          record.connectorId === undefined
        ) {
          insertConnectorId(record, pending.connectorId);
        }
        if (
          pending.action === "StartTransaction" &&
          pending.connectorId !== undefined &&
          record.messageType === "CALLRESULT"
        ) {
          const transactionId = payloadTransactionId(record.payload);
          if (transactionId !== undefined) {
            setCapped(
              this.connectorByTransaction,
              transactionKey(record, transactionId),
              pending.connectorId,
            );
          }
        }
        // OCPP-J has exactly one response per CALL: evict on consumption
        // so a long-running daemon's map doesn't grow one entry per unique
        // messageId forever.
        this.pendingByKey.delete(key);
      }
    }
    return record;
  }
}
