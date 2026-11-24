import type { RpcDialect } from "./dialects";
import {
  OCPPMessageType,
  encodeCallError,
  type RpcDecodeError,
  type RpcDecodeErrorReason,
} from "./frames";

/** The message id of a CALLERROR answering a frame whose own id cannot be
 *  read (OCPP 2.0.1 / 2.1 Part 4 §4.2.3). */
export const UNREADABLE_MESSAGE_ID = "-1";

/** The CALLERROR's description for each reason. Fixed text: the received
 *  frame is never echoed, so the answer cannot carry invalid JSON
 *  (Part 4 §4.2.3). */
const DESCRIPTIONS: Readonly<Record<RpcDecodeErrorReason, string>> = {
  "not-json": "Message is not valid JSON",
  "not-array": "Message is not a JSON array",
  "invalid-message-type": "MessageTypeId could not be read",
  "unknown-message-type": "MessageTypeId is not supported",
  "invalid-message-id": "MessageId could not be read",
  "invalid-action": "Action could not be read",
  "invalid-error": "ErrorCode or ErrorDescription could not be read",
  "wrong-length": "CALL does not have 4 elements",
};

/**
 * The CALLERROR due in answer to a frame `decodeFrame` rejected, or `null`
 * when the frame must not be answered. The rules and their sources are in
 * docs/analyses/ocpp-protocol-stack.md#malformed-frames:
 *
 * - a frame of an unknown message type is ignored (1.6 §4.1.3, 2.0.1 / 2.1
 *   Part 4 §4.1.3 and the 2026-09 errata that deprecate
 *   `MessageTypeNotSupported`);
 * - a malformed CALLRESULT, CALLERROR, CALLRESULTERROR or SEND is never
 *   answered: a CALLERROR answers a CALL, and a SEND is never answered
 *   (2.1 Part 4 §4.2.4);
 * - anything else (not JSON, not an array, an unreadable message type, a
 *   malformed CALL) is answered with the dialect's `rpcFrameworkError`
 *   under the frame's message id, or `"-1"` when it cannot be read.
 */
export function malformedFrameReply(
  error: RpcDecodeError,
  dialect: RpcDialect,
): string | null {
  if (error.reason === "unknown-message-type") return null;
  if (
    error.messageType !== undefined &&
    error.messageType !== OCPPMessageType.CALL
  )
    return null;
  return encodeCallError(
    error.messageId ?? UNREADABLE_MESSAGE_ID,
    dialect.rpcFrameworkError,
    DESCRIPTIONS[error.reason],
  );
}
