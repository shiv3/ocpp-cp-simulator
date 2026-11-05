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
