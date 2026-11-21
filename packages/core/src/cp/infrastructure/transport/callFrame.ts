import { encodeCall } from "@ocpp-cp-simulator/ocpp-rpc/index";

/** An OCPP-J CALL frame, `[2, messageId, action, payload]`, exactly as it is
 *  written to the socket. The codec is ocpp-rpc's (#978). */
export function encodeCallFrame(
  messageId: string,
  action: string,
  payload: unknown,
): string {
  return encodeCall(messageId, action, payload);
}
