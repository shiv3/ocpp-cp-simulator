// src/cli/exportK6/runtime/types.ts
// Self-contained mirror of the scenario JSON shape (subset the k6 runtime
// needs). Deliberately NOT imported from src/cp — this file is emitted
// verbatim into export bundles and must have zero repo dependencies.

export interface ScenarioNodeJson {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ScenarioEdgeJson {
  source: string;
  target: string;
}

export interface AssertionSpecJson {
  id: string;
  description?: string;
  type: string;
  action?: string;
  direction?: "sent" | "received";
  status?: string;
  occurrence?: number;
  payload?: Record<string, unknown>;
  targetStatus?: string;
  actions?: string[];
  before?: { action: string; direction?: "sent" | "received" };
  after?: { action: string; direction?: "sent" | "received" };
}

export interface EvSettingsJson {
  batteryCapacityKwh?: number;
  maxChargingPowerKw?: number;
  initialSoc?: number;
  targetSoc?: number;
}

export interface ScenarioJson {
  id: string;
  name?: string;
  targetId?: number;
  nodes: ScenarioNodeJson[];
  edges: ScenarioEdgeJson[];
  assertions?: AssertionSpecJson[];
  evSettings?: EvSettingsJson;
}

export interface CpIdentity {
  cpId: string;
  basicPassword?: string;
}

export interface TranscriptEntry {
  direction: "sent" | "received";
  action: string;
  payload: Record<string, unknown>;
  /** CALLRESULT payload for sent calls, once received. */
  response?: Record<string, unknown>;
  /** CALLERROR code when the CSMS rejected a sent call. */
  errorCode?: string;
  timeMs: number;
}

export interface WireCall {
  action: string;
  payload: Record<string, unknown>;
}

/** Version-specific payload building. wire/v16.ts implements this; Phase 2
 * adds v201/v21. The interpreter and client only speak `Wire`. */
export interface Wire {
  readonly subprotocol: string;
  bootNotification(cpId: string): WireCall;
  heartbeat(): WireCall;
  statusNotification(
    connectorId: number,
    status: string,
    extras?: {
      errorCode?: string;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
    },
  ): WireCall;
  startTransaction(
    connectorId: number,
    tagId: string,
    meterWh: number,
    nowIso: string,
  ): WireCall;
  parseStartTransactionConf(conf: Record<string, unknown>): {
    transactionId: number | null;
    accepted: boolean;
  };
  stopTransaction(
    transactionId: number,
    meterWh: number,
    nowIso: string,
    reason?: string,
  ): WireCall;
  meterValues(
    connectorId: number,
    transactionId: number | null,
    meterWh: number,
    nowIso: string,
  ): WireCall;
  dataTransfer(vendorId: string, messageId?: string, data?: string): WireCall;
  /** Incoming action names a trigger node waits on (per version). */
  triggerActions(kind: "remoteStart" | "remoteStop" | "reserveNow"): string[];
  /** Extract the idTag/idToken from a remote-start request payload. */
  remoteStartTagId(payload: Record<string, unknown>): string | null;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
