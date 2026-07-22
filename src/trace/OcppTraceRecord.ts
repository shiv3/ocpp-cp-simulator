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
 * lives in `docs/reference/trace-format.md`.
 */

/** Trace schema version. Additive optional fields bump the minor version; semantic changes bump the major. Consumers MUST ignore unknown fields. */
export const OCPP_TRACE_SCHEMA_VERSION = "1.1";

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
  /** Trace schema version, e.g. "1.1" ({@link OCPP_TRACE_SCHEMA_VERSION}). */
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
   * Action name, e.g. "BootNotification". Present on CALL frames. On
   * CALLRESULT/CALLERROR it is DERIVED by message-id correlation and
   * optional: producers MAY back-fill it, and when the CALL with the same
   * `messageId` is present in the trace it MUST equal that CALL's action.
   */
  action?: string;
  /** Request/response payload (the OCPP message body). */
  payload?: unknown;
  /**
   * Verbatim frame text exactly as sent or received on the wire (v1.1+).
   * Producers that have the original bytes SHOULD emit it; it is the only
   * lossless representation (byte-exact hashing/dedup; preserves frames whose
   * shape or payload violates the OCPP schema). Note a frame that does not
   * parse as an OCPP-J array cannot be represented as a record at all in
   * v1.1 (`messageType` is required) — carrying such frames is an open
   * question for the shared spec.
   */
  raw?: string;
  /** Populated for CALLERROR frames only. */
  error?: TraceError;
  /** Optional transport/execution metadata and analysis-specific extensions. */
  meta?: Record<string, unknown>;
}
