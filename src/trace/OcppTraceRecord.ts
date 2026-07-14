/**
 * Shared, versioned OCPP trace format (issue #188).
 *
 * A small, implementation-independent record for one OCPP message exchange,
 * designed to be usable *without* coupling to this simulator's internal log
 * model, Socket.IO contracts, persistence, or UI — so it can be consumed by
 * external analysis tools (e.g. OCPP DebugKit), shared as CI artifacts, or used
 * for reproducible bug reports and regression fixtures.
 *
 * This is the schema definition only. {@link ./logEntryToTrace} adapts the
 * simulator's own JSONL log lines into these records; a documented JSON Schema
 * lives in `docs/trace-format.md`.
 */

/** Bump on any breaking change to the record shape. Consumers should check it. */
export const OCPP_TRACE_SCHEMA_VERSION = "1.0";

/** Direction relative to the charge point / CSMS pair. */
export type TraceDirection = "cp-to-csms" | "csms-to-cp";

/** OCPP-J message frame kind. */
export type TraceMessageType = "CALL" | "CALLRESULT" | "CALLERROR";

/** Wire transport the message travelled over. */
export type TraceTransport = "json" | "soap";

/** CALLERROR detail, mapped from the OCPP-J `[4, id, code, description, details]` frame. */
export interface TraceError {
  code?: string;
  description?: string;
  details?: unknown;
}

/** One OCPP message exchange in the shared, tool-independent trace format. */
export interface OcppTraceRecord {
  /** Trace schema version, e.g. "1.0" ({@link OCPP_TRACE_SCHEMA_VERSION}). */
  schemaVersion: string;
  /** ISO-8601 timestamp of the message. */
  timestamp: string;
  /** OCPP protocol version, e.g. "1.6", "2.0.1" (when known). */
  ocppVersion?: string;
  /** Transport the message travelled over. */
  transport: TraceTransport;
  /** Charge-point identity (when known). */
  chargePointId?: string;
  /** Connector id, when the message is connector-scoped and known. */
  connectorId?: number;
  /** Message direction relative to the CP/CSMS pair. */
  direction: TraceDirection;
  /** OCPP-J frame kind. */
  messageType: TraceMessageType;
  /** OCPP message id used to correlate a CALL with its CALLRESULT/CALLERROR. */
  messageId?: string;
  /**
   * Action name, e.g. "BootNotification". Present on CALL frames; on
   * CALLRESULT/CALLERROR it is back-filled by message-id correlation when the
   * originating CALL is available, otherwise omitted (correlate by messageId).
   */
  action?: string;
  /** Request/response payload (the OCPP message body). */
  payload?: unknown;
  /** Populated for CALLERROR frames only. */
  error?: TraceError;
  /** Optional transport/execution metadata and analysis-specific extensions. */
  meta?: Record<string, unknown>;
}
