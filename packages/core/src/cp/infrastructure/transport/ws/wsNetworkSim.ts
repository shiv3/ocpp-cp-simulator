import { WS_READY_STATE } from "./readyState";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import type { OcppSocket } from "../wsUrlWithBasic";
import type { MessageHandler } from "../OCPPWebSocket";

/**
 * Physical send (the actual websocket.send call).
 * This is what the ControllerHost.writeUpstream calls.
 */
export function writeUpstreamPhysical(
  ws: OcppSocket | null,
  raw: string,
  logger: Logger,
): void {
  if (!ws || ws.readyState !== WS_READY_STATE.OPEN) {
    // A delayed frame can reach its release after the socket dropped. Throw
    // so the pipeline settles it `write_failed` instead of `written` — a
    // frame that never hit the wire must stay in its sender's custody
    // (transaction CALLs are salvaged into PendingMessageQueue from there).
    // The send methods gate on isConnected(), so the immediate paths never
    // land here.
    logger.warn("WebSocket is not connected", LogType.WEBSOCKET);
    throw new Error("WebSocket is not connected");
  }
  ws.send(raw);
  logger.info(`Sent: ${raw}`, LogType.WEBSOCKET);
}

/** What `dispatchIncomingFrame` needs from the socket. */
export interface IncomingDispatchContext {
  readonly logger: Logger;
  /** Returns true when the frame was consumed (#393). */
  intercept(frame: unknown[]): boolean;
  /** The current message handler, or null. */
  handler(): MessageHandler | null;
}

/**
 * Dispatch incoming message through the normal parse/validate path.
 * This is what the ControllerHost.dispatchDownstream calls after any delay.
 */
export function dispatchIncomingFrame(
  raw: string,
  ctx: IncomingDispatchContext,
): void {
  ctx.logger.info(`Received: ${raw}`, LogType.WEBSOCKET);
  try {
    const messageArray = JSON.parse(raw);

    // Validate message format: must be array with length 3 (CALLRESULT), 4 (CALL), or 5 (CALLERROR)
    if (
      !Array.isArray(messageArray) ||
      messageArray.length < 3 ||
      messageArray.length > 5
    ) {
      ctx.logger.error(
        "Invalid message format: " + messageArray,
        LogType.WEBSOCKET,
      );
      return;
    }

    if (ctx.intercept(messageArray)) return;

    const messageHandler = ctx.handler();
    if (messageHandler) {
      if (messageArray.length === 3) {
        // CALLRESULT: [messageType, messageId, payload]
        const [messageType, messageId, payload] = messageArray;
        messageHandler(messageType, messageId, OCPPAction.CallResult, payload);
      } else if (messageArray.length === 4) {
        // CALL: [messageType, messageId, action, payload]
        const [messageType, messageId, action, payload] = messageArray;
        messageHandler(messageType, messageId, action, payload);
      } else if (messageArray.length === 5) {
        // CALLERROR: [messageType, messageId, errorCode, errorDescription, errorDetails]
        const [
          messageType,
          messageId,
          errorCode,
          errorDescription,
          errorDetails,
        ] = messageArray;
        messageHandler(messageType, messageId, OCPPAction.CallResult, {
          errorCode,
          errorDescription,
          errorDetails: errorDetails ?? {},
        });
      }
    } else {
      ctx.logger.warn("No message handler set", LogType.WEBSOCKET);
    }
  } catch (error) {
    ctx.logger.error(`Error parsing message: ${error}`, LogType.WEBSOCKET);
  }
}
