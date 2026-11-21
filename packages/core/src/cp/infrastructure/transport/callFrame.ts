import { OCPPMessageType } from "../../domain/types/OcppTypes";

/** An OCPP-J CALL frame, `[2, messageId, action, payload]`, exactly as it is
 *  written to the socket. */
export function encodeCallFrame(
  messageId: string,
  action: string,
  payload: unknown,
): string {
  return JSON.stringify([OCPPMessageType.CALL, messageId, action, payload]);
}

/** An OCPP 2.1 SEND frame, `[6, messageId, action, payload]` (Part 2 FR.07):
 *  an unconfirmed message the CSMS never answers. */
export function encodeSendFrame(
  messageId: string,
  action: string,
  payload: unknown,
): string {
  return JSON.stringify([OCPPMessageType.SEND, messageId, action, payload]);
}
