/**
 * The OCPP-J frame codec (OCPP-J 1.6 §4, OCPP 2.0.1 / 2.1 Part 4 §4): the
 * message types, their encoders and a decoder that never throws. The
 * encoders write exactly the bytes the simulator has always written: the
 * array is serialized as given, payload keys in insertion order, and a
 * CALLERROR or CALLRESULTERROR without details carries `{}`.
 */

/** The message type id, the first element of every OCPP-J frame. 2-4 exist
 *  in every OCPP-J version; 5 and 6 only in OCPP 2.1 (Part 4 §4.1.3). */
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
  return encodeError(
    OCPPMessageType.CALLERROR,
    messageId,
    errorCode,
    errorDescription,
    errorDetails,
  );
}

/** OCPP 2.1 `[5, messageId, errorCode, errorDescription, errorDetails]`:
 *  the answer to a CALLRESULT that could not be processed, under the
 *  CALLRESULT's message id (Part 4 §4.2.3); details default to `{}`. */
export function encodeCallResultError(
  messageId: string,
  errorCode: string,
  errorDescription: string,
  errorDetails?: object,
): string {
  return encodeError(
    OCPPMessageType.CALLRESULTERROR,
    messageId,
    errorCode,
    errorDescription,
    errorDetails,
  );
}

/** OCPP 2.1 `[6, messageId, action, payload]`: an unconfirmed message the
 *  receiver never answers (Part 4 §4.2.4). */
export function encodeSend(
  messageId: string,
  action: string,
  payload: unknown,
): string {
  return JSON.stringify([OCPPMessageType.SEND, messageId, action, payload]);
}

function encodeError(
  type: OCPPMessageType.CALLERROR | OCPPMessageType.CALLRESULTERROR,
  messageId: string,
  errorCode: string,
  errorDescription: string,
  errorDetails: object | undefined,
): string {
  return JSON.stringify([
    type,
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

/** OCPP 2.1: the peer could not process a CALLRESULT this side sent. The
 *  message id is the one of the CALL the peer had sent. */
export interface RpcCallResultErrorFrame {
  readonly kind: "callResultError";
  readonly messageId: string;
  readonly errorCode: string;
  readonly errorDescription: string;
  /** Absent when the peer sent a four-element CALLRESULTERROR. */
  readonly errorDetails: unknown;
}

/** OCPP 2.1: an unconfirmed message, never answered. */
export interface RpcSendFrame {
  readonly kind: "send";
  readonly messageId: string;
  readonly action: string;
  readonly payload: unknown;
}

export type RpcFrame =
  | RpcCallFrame
  | RpcCallResultFrame
  | RpcCallErrorFrame
  | RpcCallResultErrorFrame
  | RpcSendFrame;

export interface DecodeFrameOptions {
  /** Whether the OCPP 2.1 message types (CALLRESULTERROR, SEND) exist. With
   *  `false`, as for a 1.6 or 2.0.1 reader, they are `unknown-message-type`
   *  whatever their content. Defaults to `true`. */
  readonly ocpp21?: boolean;
}

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
export function decodeFrame(
  raw: string,
  options: DecodeFrameOptions = {},
): RpcFrame | RpcDecodeError {
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

  const ocpp21 = options.ocpp21 ?? true;
  switch (type) {
    case OCPPMessageType.CALL:
      return decodeActionFrame("call", messageId, parsed, invalid);
    case OCPPMessageType.CALLRESULT:
      if (parsed.length !== 3) return invalid("wrong-length", messageId);
      return { kind: "callResult", messageId, payload: parsed[2] };
    case OCPPMessageType.CALLERROR:
      return decodeErrorFrame("callError", messageId, parsed, invalid);
    case OCPPMessageType.CALLRESULTERROR:
      if (!ocpp21) return invalid("unknown-message-type", messageId);
      return decodeErrorFrame("callResultError", messageId, parsed, invalid);
    case OCPPMessageType.SEND:
      if (!ocpp21) return invalid("unknown-message-type", messageId);
      return decodeActionFrame("send", messageId, parsed, invalid);
    default:
      return invalid("unknown-message-type", messageId);
  }
}

type Invalid = (
  reason: RpcDecodeErrorReason,
  messageId?: string,
) => RpcDecodeError;

/** A CALL or a SEND: `[type, messageId, action, payload]`. */
function decodeActionFrame<K extends "call" | "send">(
  kind: K,
  messageId: string,
  parsed: readonly unknown[],
  invalid: Invalid,
):
  | { kind: K; messageId: string; action: string; payload: unknown }
  | RpcDecodeError {
  if (parsed.length !== 4) return invalid("wrong-length", messageId);
  const action: unknown = parsed[2];
  if (typeof action !== "string" || action === "")
    return invalid("invalid-action", messageId);
  return { kind, messageId, action, payload: parsed[3] };
}

/** A CALLERROR or a CALLRESULTERROR: `[type, messageId, errorCode,
 *  errorDescription, errorDetails?]`. */
function decodeErrorFrame<K extends "callError" | "callResultError">(
  kind: K,
  messageId: string,
  parsed: readonly unknown[],
  invalid: Invalid,
):
  | {
      kind: K;
      messageId: string;
      errorCode: string;
      errorDescription: string;
      errorDetails: unknown;
    }
  | RpcDecodeError {
  if (parsed.length !== 4 && parsed.length !== 5)
    return invalid("wrong-length", messageId);
  const errorCode: unknown = parsed[2];
  const errorDescription: unknown = parsed[3];
  if (typeof errorCode !== "string" || typeof errorDescription !== "string")
    return invalid("invalid-error", messageId);
  return {
    kind,
    messageId,
    errorCode,
    errorDescription,
    errorDetails: parsed[4],
  };
}
