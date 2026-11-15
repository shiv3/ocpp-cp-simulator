/**
 * The OCPP-J frame codec (OCPP-J 1.6 §4, OCPP 2.0.1 / 2.1 Part 4 §4): the
 * three message types, their encoders and a decoder that never throws. The
 * encoders write exactly the bytes the simulator has always written: the
 * array is serialized as given, payload keys in insertion order, and a
 * CALLERROR without details carries `{}`.
 */

/** The message type id, the first element of every OCPP-J frame. `decodeFrame`
 *  and `RpcEndpoint` handle 2-4 only; the OCPP 2.1 types are listed for the
 *  encoders that write them. */
export enum OCPPMessageType {
  CALL = 2,
  CALLRESULT = 3,
  CALLERROR = 4,
  /** OCPP 2.1 CALLRESULTERROR: a caller's answer to a CALLRESULT it cannot accept. */
  CALLRESULTERROR = 5,
  /** OCPP 2.1 SEND: an unconfirmed message, never answered. */
  SEND = 6,
}

/** `[2, messageId, action, payload]`. */
export function encodeCall(
  messageId: string,
  action: string,
  payload: unknown,
): string {
  return JSON.stringify([OCPPMessageType.CALL, messageId, action, payload]);
}

/** `[3, messageId, payload]`. */
export function encodeCallResult(messageId: string, payload: unknown): string {
  return JSON.stringify([OCPPMessageType.CALLRESULT, messageId, payload]);
}

/** `[4, messageId, errorCode, errorDescription, errorDetails]`; details
 *  default to `{}`, which both 1.6 and 2.x require to be present. */
export function encodeCallError(
  messageId: string,
  errorCode: string,
  errorDescription: string,
  errorDetails?: object,
): string {
  return JSON.stringify([
    OCPPMessageType.CALLERROR,
    messageId,
    errorCode,
    errorDescription,
    errorDetails ?? {},
  ]);
}

export interface RpcCallFrame {
  readonly kind: "call";
  readonly messageId: string;
  readonly action: string;
  readonly payload: unknown;
}

export interface RpcCallResultFrame {
  readonly kind: "callResult";
  readonly messageId: string;
  readonly payload: unknown;
}

export interface RpcCallErrorFrame {
  readonly kind: "callError";
  readonly messageId: string;
  readonly errorCode: string;
  readonly errorDescription: string;
  /** Absent when the peer sent a four-element CALLERROR. */
  readonly errorDetails: unknown;
}

export type RpcFrame = RpcCallFrame | RpcCallResultFrame | RpcCallErrorFrame;

/** Why a text frame is not an OCPP-J frame. */
export type RpcDecodeErrorReason =
  | "not-json"
  | "not-array"
  | "unknown-message-type"
  | "invalid-message-id"
  | "invalid-action"
  | "invalid-error"
  | "wrong-length";

export interface RpcDecodeError {
  readonly kind: "invalid";
  readonly reason: RpcDecodeErrorReason;
  /** The frame as received. */
  readonly raw: string;
  /** Set once the message id itself could be read. */
  readonly messageId?: string;
}

/** Parse one text frame. Never throws: a frame that is not OCPP-J comes back
 *  as an `RpcDecodeError` naming the first problem found. */
export function decodeFrame(raw: string): RpcFrame | RpcDecodeError {
  const invalid = (
    reason: RpcDecodeErrorReason,
    messageId?: string,
  ): RpcDecodeError =>
    messageId === undefined
      ? { kind: "invalid", reason, raw }
      : { kind: "invalid", reason, raw, messageId };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("not-json");
  }
  if (!Array.isArray(parsed)) return invalid("not-array");
  const [type, messageId] = parsed as unknown[];
  if (typeof messageId !== "string" || messageId === "")
    return invalid("invalid-message-id");

  switch (type) {
    case OCPPMessageType.CALL: {
      if (parsed.length !== 4) return invalid("wrong-length", messageId);
      const action: unknown = parsed[2];
      if (typeof action !== "string" || action === "")
        return invalid("invalid-action", messageId);
      return { kind: "call", messageId, action, payload: parsed[3] };
    }
    case OCPPMessageType.CALLRESULT:
      if (parsed.length !== 3) return invalid("wrong-length", messageId);
      return { kind: "callResult", messageId, payload: parsed[2] };
    case OCPPMessageType.CALLERROR: {
      if (parsed.length !== 4 && parsed.length !== 5)
        return invalid("wrong-length", messageId);
      const errorCode: unknown = parsed[2];
      const errorDescription: unknown = parsed[3];
      if (typeof errorCode !== "string" || typeof errorDescription !== "string")
        return invalid("invalid-error", messageId);
      return {
        kind: "callError",
        messageId,
        errorCode,
        errorDescription,
        errorDetails: parsed[4],
      };
    }
    default:
      return invalid("unknown-message-type", messageId);
  }
}
