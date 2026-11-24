import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import {
  OCPPAction,
  type OCPPErrorCode,
  type OCPPMessageType,
} from "../../../domain/types/OcppTypes";
import { OCPP_2_1, isOcpp2Version } from "../../../domain/types/OcppVersion";
import {
  OCPP16_RPC_DIALECT,
  OCPP21_RPC_DIALECT,
  OCPP2X_RPC_DIALECT,
  decodeParsedFrame,
  malformedFrameReply,
  type RpcDecodeError,
  type RpcDialect,
} from "@ocpp-cp-simulator/ocpp-rpc/index";
import type { OcppSocket } from "../wsUrlWithBasic";
import type { MessageHandler, OcppMessagePayload } from "../OCPPWebSocket";

/**
 * Physical send (the actual websocket.send call).
 * This is what the ControllerHost.writeUpstream calls.
 */
export function writeUpstreamPhysical(
  ws: OcppSocket | null,
  raw: string,
  logger: Logger,
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
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
  /** The connection's OCPP version: its error codes and message types. */
  readonly ocppVersion: string;
  /** Returns true when the frame was consumed (#393). */
  intercept(frame: unknown[]): boolean;
  /** The current message handler, or null. */
  handler(): MessageHandler | null;
  /** Writes the CALLERROR answering a malformed frame (#1060). */
  reply(frame: string): void;
}

/** The ocpp-rpc dialect of an OCPP-J version string. */
export function rpcDialectOf(ocppVersion: string): RpcDialect {
  if (ocppVersion === OCPP_2_1) return OCPP21_RPC_DIALECT;
  if (isOcpp2Version(ocppVersion)) return OCPP2X_RPC_DIALECT;
  return OCPP16_RPC_DIALECT;
}

/**
 * Dispatch incoming message through the normal parse/validate path.
 * This is what the ControllerHost.dispatchDownstream calls after any delay.
 *
 * A frame that is not OCPP-J for the connection's version is logged and
 * answered with the CALLERROR OCPP-J asks for, if any (#1060,
 * docs/analyses/ocpp-protocol-stack.md#malformed-frames); it never reaches
 * the message handler. The interceptor still sees every array of 3 to 5
 * elements first, malformed or not.
 */
export function dispatchIncomingFrame(
  raw: string,
  ctx: IncomingDispatchContext,
): void {
  ctx.logger.info(`Received: ${raw}`, LogType.WEBSOCKET);
  let messageArray: unknown;
  try {
    messageArray = JSON.parse(raw);
  } catch {
    rejectFrame({ kind: "invalid", reason: "not-json", raw }, ctx);
    return;
  }
  if (
    Array.isArray(messageArray) &&
    messageArray.length >= 3 &&
    messageArray.length <= 5
  ) {
    let consumed: boolean;
    try {
      consumed = ctx.intercept(messageArray);
    } catch (error) {
      // A throwing interceptor must not escape into the socket's onmessage.
      ctx.logger.error(`Error parsing message: ${error}`, LogType.WEBSOCKET);
      return;
    }
    if (consumed) return;
  }

  const dialect = rpcDialectOf(ctx.ocppVersion);
  const decoded = decodeParsedFrame(messageArray, raw, {
    ocpp21: dialect.ocpp21MessageTypes,
  });
  if (decoded.kind === "invalid") {
    rejectFrame(decoded, ctx);
    return;
  }
  // A valid frame is an array of 3 to 5 elements.
  const frame = messageArray as unknown[];

  try {
    const messageHandler = ctx.handler();
    if (messageHandler) {
      if (frame.length === 3) {
        // CALLRESULT: [messageType, messageId, payload]
        const [messageType, messageId, payload] = frame as [
          OCPPMessageType,
          string,
          OcppMessagePayload,
        ];
        messageHandler(messageType, messageId, OCPPAction.CallResult, payload);
      } else if (frame.length === 4) {
        // CALL: [messageType, messageId, action, payload]
        const [messageType, messageId, action, payload] = frame as [
          OCPPMessageType,
          string,
          OCPPAction,
          OcppMessagePayload,
        ];
        messageHandler(messageType, messageId, action, payload);
      } else if (frame.length === 5) {
        // CALLERROR: [messageType, messageId, errorCode, errorDescription, errorDetails]
        const [
          messageType,
          messageId,
          errorCode,
          errorDescription,
          errorDetails,
        ] = frame as [OCPPMessageType, string, OCPPErrorCode, string, object];
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

/** Log a malformed frame and send the CALLERROR it is due, if any. */
function rejectFrame(
  error: RpcDecodeError,
  ctx: IncomingDispatchContext,
): void {
  ctx.logger.error(
    `Invalid message format: ${error.reason}`,
    LogType.WEBSOCKET,
  );
  const reply = malformedFrameReply(error, rpcDialectOf(ctx.ocppVersion));
  if (reply !== null) ctx.reply(reply);
}
