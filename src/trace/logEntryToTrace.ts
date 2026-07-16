/**
 * Adapt this simulator's JSONL log lines into the shared, versioned OCPP trace
 * format (issue #188). Neutral by design: it maps *from* the simulator's own
 * text log *to* the tool-independent {@link OcppTraceRecord}, so the format
 * stays decoupled from the simulator's internals.
 *
 * Only OCPP-J (JSON/WebSocket) wire frames are recognized in this first
 * iteration; SOAP transport is a documented follow-up. Non-wire log lines
 * (diagnostics, scenario/general logs) map to `null`.
 */

import {
  OCPP_TRACE_SCHEMA_VERSION,
  type OcppTraceRecord,
  type TraceDirection,
  type TraceError,
  type TraceMessageType,
  type TraceTransport,
} from "./OcppTraceRecord";

/** A serialized simulator log line (`--log-format json`, `logs.get`, or the
 *  browser log-viewer download): `{ timestamp, level, type, message, cpId? }`. */
export interface SerializedLogLine {
  timestamp: string;
  level?: string;
  type?: string;
  message: string;
  cpId?: string;
}

export interface TraceContext {
  /** OCPP protocol version to stamp on records, e.g. "1.6". */
  ocppVersion?: string;
  /** Transport override; defaults to "json" (OCPP-J / WebSocket). */
  transport?: TraceTransport;
  /** Charge-point id fallback when a log line carries no `cpId`. */
  chargePointId?: string;
}

const WS_SENT_PREFIX = "Sent: ";
const WS_RECEIVED_PREFIX = "Received: ";

const OCPPJ_CALL = 2;
const OCPPJ_CALLRESULT = 3;
const OCPPJ_CALLERROR = 4;

interface ParsedFrame {
  direction: TraceDirection;
  messageType: TraceMessageType;
  messageId?: string;
  action?: string;
  payload?: unknown;
  error?: TraceError;
  raw: string;
}

function parseOcppJArray(
  json: string,
  direction: TraceDirection,
): ParsedFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return null;
  const [type, id] = parsed;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const messageId = String(id);

  if (type === OCPPJ_CALL && typeof parsed[2] === "string") {
    return {
      direction,
      messageType: "CALL",
      messageId,
      action: parsed[2],
      payload: parsed[3],
      raw: json,
    };
  }
  if (type === OCPPJ_CALLRESULT) {
    return {
      direction,
      messageType: "CALLRESULT",
      messageId,
      payload: parsed[2],
      raw: json,
    };
  }
  if (type === OCPPJ_CALLERROR) {
    return {
      direction,
      messageType: "CALLERROR",
      messageId,
      error: {
        code: typeof parsed[2] === "string" ? parsed[2] : undefined,
        description: typeof parsed[3] === "string" ? parsed[3] : undefined,
        details: parsed[4],
      },
      raw: json,
    };
  }
  return null;
}

function parseWireFrame(message: string): ParsedFrame | null {
  if (message.startsWith(WS_SENT_PREFIX)) {
    return parseOcppJArray(message.slice(WS_SENT_PREFIX.length), "cp-to-csms");
  }
  if (message.startsWith(WS_RECEIVED_PREFIX)) {
    return parseOcppJArray(
      message.slice(WS_RECEIVED_PREFIX.length),
      "csms-to-cp",
    );
  }
  return null;
}

function toRecord(
  line: SerializedLogLine,
  frame: ParsedFrame,
  context: TraceContext,
): OcppTraceRecord {
  const record: OcppTraceRecord = {
    schemaVersion: OCPP_TRACE_SCHEMA_VERSION,
    timestamp: line.timestamp,
    transport: context.transport ?? "json",
    direction: frame.direction,
    messageType: frame.messageType,
  };
  const ocppVersion = context.ocppVersion;
  if (ocppVersion) record.ocppVersion = ocppVersion;
  const chargePointId = line.cpId ?? context.chargePointId;
  if (chargePointId) record.chargePointId = chargePointId;
  if (frame.messageId !== undefined) record.messageId = frame.messageId;
  if (frame.action !== undefined) record.action = frame.action;
  if (frame.payload !== undefined) record.payload = frame.payload;
  if (frame.error !== undefined) record.error = frame.error;
  record.raw = frame.raw;
  return record;
}

/**
 * Convert a single log line to a trace record, or `null` if it is not an
 * OCPP-J wire frame. CALLRESULT/CALLERROR records carry no `action` (there is
 * no cross-line context here); use {@link logLinesToTrace} to back-fill it.
 */
export function logLineToTraceRecord(
  line: SerializedLogLine,
  context: TraceContext = {},
): OcppTraceRecord | null {
  const frame = parseWireFrame(line.message);
  if (!frame) return null;
  return toRecord(line, frame, context);
}

/** Correlation key scoped per charge point: a batch can interleave multiple CPs
 *  (e.g. the daemon's JSON log), and two CPs may reuse the same messageId. The
 *  JSON tuple stays unambiguous whatever the cpId/messageId contain. */
function correlationKey(record: OcppTraceRecord): string {
  return JSON.stringify([record.chargePointId ?? "", record.messageId]);
}

/**
 * Convert a chronological batch of log lines to trace records, dropping
 * non-wire lines and back-filling each CALLRESULT/CALLERROR `action` from the
 * CALL that established its `messageId` (correlated per charge point).
 */
export function logLinesToTrace(
  lines: readonly SerializedLogLine[],
  context: TraceContext = {},
): OcppTraceRecord[] {
  const actionByKey = new Map<string, string>();
  const records: OcppTraceRecord[] = [];
  for (const line of lines) {
    const record = logLineToTraceRecord(line, context);
    if (!record) continue;
    if (record.messageId !== undefined) {
      const key = correlationKey(record);
      if (record.action) {
        actionByKey.set(key, record.action);
      } else {
        const resolved = actionByKey.get(key);
        if (resolved) record.action = resolved;
      }
    }
    records.push(record);
  }
  return records;
}
