import type { ChargePointStatus, JsonEvent, JsonResponse } from "./types";

export function formatStatus(status: ChargePointStatus): string {
  const lines: string[] = [
    `ChargePoint: ${status.id}  Status: ${status.status}`,
  ];

  if (status.error) {
    lines.push(`  Error: ${status.error}`);
  }

  for (const c of status.connectors) {
    const txInfo = c.transactionId != null ? `  TX#${c.transactionId}` : "";
    lines.push(
      `  Connector ${c.id}: ${c.status} (${c.availability})  Meter: ${c.meterValue} Wh${txInfo}`,
    );
  }

  return lines.join("\n");
}

export function formatEvent(event: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (event) {
    case "connector_status":
      return `[EVENT] connector ${d.connectorId}: ${d.previousStatus} -> ${d.status}`;
    case "connected":
      return "[EVENT] connected to CSMS";
    case "disconnected":
      return `[EVENT] disconnected (code: ${d.code}, reason: ${d.reason})`;
    case "status_change":
      return `[EVENT] charge point status: ${d.status}`;
    case "error":
      return `[EVENT] error: ${d.error}`;
    case "transaction_started":
      return `[EVENT] transaction started on connector ${d.connectorId} (tag: ${d.tagId})`;
    case "transaction_stopped":
      return `[EVENT] transaction stopped on connector ${d.connectorId}`;
    case "meter_value":
      return `[EVENT] connector ${d.connectorId} meter: ${d.meterValue} Wh`;
    default:
      return `[EVENT] ${event}: ${JSON.stringify(data)}`;
  }
}

export function toJsonResponse(
  id: string | null,
  ok: boolean,
  dataOrError?: unknown,
): JsonResponse {
  if (ok) {
    return {
      id,
      ok,
      ...(dataOrError !== undefined ? { data: dataOrError } : {}),
    };
  }
  return { id, ok, error: String(dataOrError) };
}

export function toJsonEvent(event: string, data: unknown): JsonEvent {
  return {
    event,
    data,
    timestamp: new Date().toISOString(),
  };
}
