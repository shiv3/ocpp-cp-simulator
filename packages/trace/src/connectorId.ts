/**
 * The trace record's optional `connectorId` ("Connector id when
 * connector-scoped and known", integer >= 0), as this simulator derives it
 * (#999). {@link ./logEntryToTrace} reads it from a CALL's own payload;
 * {@link ./TraceCorrelator} back-fills it on responses and on the 1.6
 * transaction CALLs that only carry a `transactionId`.
 */

import type { TraceRecord } from "@open-ocpp-trace/core";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asConnectorId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The connector a CALL payload names, or `undefined`: a top-level integer
 * `connectorId` >= 0 (every 1.6 connector-scoped request; 2.0.1 / 2.1
 * StatusNotification and UnlockConnector, beside `evseId`), else a top-level
 * `evse.connectorId` (2.0.1 / 2.1 TransactionEvent, ChangeAvailability,
 * TriggerMessage). EVSE objects nested deeper (GetVariables, NotifyReport, …)
 * do not make a frame connector-scoped. 1.6 has no `evse` field, so the rule
 * needs no version switch.
 */
export function payloadConnectorId(payload: unknown): number | undefined {
  const object = asObject(payload);
  if (!object) return undefined;
  return (
    asConnectorId(object.connectorId) ??
    asConnectorId(asObject(object.evse)?.connectorId)
  );
}

/** The integer `transactionId` a 1.6 payload carries, or `undefined`. */
export function payloadTransactionId(payload: unknown): number | undefined {
  const value = asObject(payload)?.transactionId;
  return typeof value === "number" ? value : undefined;
}

/**
 * Set `connectorId` on `record` in place, in its documented slot: right
 * after `chargePointId`, else right before `messageId` (the converter's
 * order, see `toRecord`). Key order is visible in every JSONL line
 * (byte-compared), and callers keep the record's reference, so the keys
 * after the slot are re-added in their old order rather than the record
 * being rebuilt.
 */
export function insertConnectorId(
  record: TraceRecord,
  connectorId: number,
): void {
  const target = record as unknown as Record<string, unknown>;
  const keys = Object.keys(target);
  const afterCp = keys.indexOf("chargePointId");
  const slot = afterCp !== -1 ? afterCp + 1 : keys.indexOf("messageId");
  const moved = slot === -1 ? [] : keys.slice(slot);
  const values = moved.map((key) => target[key]);
  for (const key of moved) delete target[key];
  target.connectorId = connectorId;
  moved.forEach((key, i) => {
    target[key] = values[i];
  });
}
