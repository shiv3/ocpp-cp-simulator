// src/cli/exportK6/runtime/frames.ts
// OCPP-J wire framing (same array framing for 1.6J/2.0.1/2.1).

export type IncomingFrame =
  | {
      kind: "call";
      messageId: string;
      action: string;
      payload: Record<string, unknown>;
    }
  | { kind: "result"; messageId: string; payload: Record<string, unknown> }
  | {
      kind: "error";
      messageId: string;
      errorCode: string;
      errorDescription: string;
    };

const CALL = 2;
const CALLRESULT = 3;
const CALLERROR = 4;

export function encodeCall(
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify([CALL, messageId, action, payload]);
}

export function encodeCallResult(
  messageId: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify([CALLRESULT, messageId, payload]);
}

export function encodeCallError(
  messageId: string,
  errorCode: string,
  errorDescription: string,
): string {
  return JSON.stringify([
    CALLERROR,
    messageId,
    errorCode,
    errorDescription,
    {},
  ]);
}

export function decodeFrame(raw: string): IncomingFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const [type, messageId] = parsed;
  if (typeof messageId !== "string") return null;
  if (type === CALL && typeof parsed[2] === "string") {
    return {
      kind: "call",
      messageId,
      action: parsed[2],
      payload: asRecord(parsed[3]),
    };
  }
  if (type === CALLRESULT) {
    return { kind: "result", messageId, payload: asRecord(parsed[2]) };
  }
  if (type === CALLERROR) {
    return {
      kind: "error",
      messageId,
      errorCode: typeof parsed[2] === "string" ? parsed[2] : "UnknownError",
      errorDescription: typeof parsed[3] === "string" ? parsed[3] : "",
    };
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function createMessageIdGenerator(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
