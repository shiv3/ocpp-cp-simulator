import type { LogEntry } from "@/cp/shared/Logger";

/**
 * Best-effort extraction of the OCPP action name and wire direction from a
 * {@link LogEntry} message string (#178 item E).
 *
 * `LogEntry` (`src/cp/shared/Logger.ts`) has no structured `action`/
 * `direction` field — every OCPP action name and direction is baked into
 * free-text log lines written by the transport layer. Two wire-level
 * message shapes carry enough structure to parse reliably (confirmed
 * against the actual emit sites, not guessed):
 *
 *  - WebSocket transport (`OCPPWebSocket.ts` `send()`/`handleMessage()`):
 *    `"Sent: <json>"` / `"Received: <json>"`, where `<json>` is the raw
 *    OCPP-J array: `[2, id, action, payload]` (CALL),
 *    `[3, id, payload]` (CALLRESULT), `[4, id, code, desc, details]`
 *    (CALLERROR).
 *  - SOAP transport (`OCPPSoapHandler.ts` `postSoap()`):
 *    `"SOAP POST <operation>: <xml>"` (request) /
 *    `"SOAP response <operation>: <xml>"` (response).
 *
 * OCPP-J CALLRESULT/CALLERROR frames don't carry the action name inline by
 * design (the spec correlates by message id, not by repeating the action).
 * {@link annotateOcppLogs} resolves those by tracking `messageId -> action`
 * across the *whole* chronological log list, so e.g. a
 * `"Received: [3, \"42\", {...}]"` line correlates back to whichever CALL
 * frame (sent or received) established id `"42"`.
 *
 * Log lines that aren't wire traffic (diagnostics like "Suppressing X",
 * "Handling incoming message: ...", scenario/general logs, SOAP fault
 * errors, etc.) simply produce `{}` — no action, no direction. This is an
 * intentionally lossy, best-effort parse rather than a LogEntry data-model
 * change; see the #178 item E scout note (docs/architecture or
 * .superpowers/sdd/scout-178.md) for the enrich-vs-parse tradeoff.
 */

export type LogDirection = "sent" | "received";

export interface OcppLogInfo {
  action?: string;
  direction?: LogDirection;
}

const WS_SENT_PREFIX = "Sent: ";
const WS_RECEIVED_PREFIX = "Received: ";
const SOAP_POST_RE = /^SOAP POST (\S+):/;
const SOAP_RESPONSE_RE = /^SOAP response (\S+):/;

const OCPPJ_CALL = 2;
const OCPPJ_CALLRESULT = 3;
const OCPPJ_CALLERROR = 4;

interface WireFrame {
  direction: LogDirection;
  messageId?: string;
  /** Present for CALL frames (and SOAP, which always names the operation).
   *  Absent for CALLRESULT/CALLERROR frames — those get resolved via
   *  {@link annotateOcppLogs}'s messageId correlation. */
  action?: string;
}

function parseWireArrayMessage(
  json: string,
  direction: LogDirection,
): WireFrame | null {
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
    return { direction, messageId, action: parsed[2] };
  }
  if (type === OCPPJ_CALLRESULT || type === OCPPJ_CALLERROR) {
    return { direction, messageId };
  }
  return null;
}

function parseSingleMessage(message: string): WireFrame | null {
  if (message.startsWith(WS_SENT_PREFIX)) {
    return parseWireArrayMessage(message.slice(WS_SENT_PREFIX.length), "sent");
  }
  if (message.startsWith(WS_RECEIVED_PREFIX)) {
    return parseWireArrayMessage(
      message.slice(WS_RECEIVED_PREFIX.length),
      "received",
    );
  }
  const postMatch = SOAP_POST_RE.exec(message);
  if (postMatch) return { direction: "sent", action: postMatch[1] };
  const responseMatch = SOAP_RESPONSE_RE.exec(message);
  if (responseMatch) {
    return { direction: "received", action: responseMatch[1] };
  }
  return null;
}

/**
 * Parse every entry's message for action/direction, resolving
 * CALLRESULT/CALLERROR action names by message-id correlation against
 * earlier CALL frames in the same list.
 *
 * `logs` should be the full, chronological log list (not a
 * filtered/paginated subset) so correlation isn't broken by an active
 * filter hiding the CALL frame that named the action. Returns one
 * {@link OcppLogInfo} per input entry, same order/length as `logs`.
 */
export function annotateOcppLogs(
  logs: Pick<LogEntry, "message">[],
): OcppLogInfo[] {
  const actionByMessageId = new Map<string, string>();
  return logs.map((log) => {
    const frame = parseSingleMessage(log.message);
    if (!frame) return {};
    if (frame.action) {
      if (frame.messageId) {
        actionByMessageId.set(frame.messageId, frame.action);
      }
      return { action: frame.action, direction: frame.direction };
    }
    const resolved = frame.messageId
      ? actionByMessageId.get(frame.messageId)
      : undefined;
    return { action: resolved, direction: frame.direction };
  });
}
