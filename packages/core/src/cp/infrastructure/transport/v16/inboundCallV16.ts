// Inbound CALL handling of OCPPMessageHandler (#877): the gate, the registry
// lookup, validation and the answer through the exchange.
import { OCPPErrorCodeV16 } from "@ocpp-cp-simulator/ocpp";
import { behaviorTapOf } from "../behaviorTap";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import { normalizeHandlerResult, type HandlerResult } from "../network-sim";
import type { ResponseEffectQueue } from "../network-sim";
import type { GenerationToken } from "../network-sim/NetworkSimController";
import type { HandlerContext, MessageHandlerRegistry } from "../handlers";
import { HandlerCallError } from "../handlers/HandlerCallError";
import { inboundV16Violation } from "../codec/validateV16";
import { CallExchange } from "../inbound/CallExchange";
import type { InboundCallGate } from "../inbound/InboundCallGate";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type {
  OCPPAction,
  OCPPErrorCode,
} from "../../../domain/types/OcppTypes";
import type { OcppMessagePayloadCall } from "./payloadTypesV16";

/** What the inbound CALL handling needs from the 1.6 handler. */
export interface InboundCallsV16Context {
  readonly chargePoint: ChargePoint;
  readonly webSocket: OCPPWebSocket;
  readonly logger: Logger;
  /** A function: the handler fills its registry after construction. */
  readonly registry: () => MessageHandlerRegistry;
  readonly gate: InboundCallGate;
  readonly responseEffectQueue: ResponseEffectQueue;
}

export class InboundCallsV16 {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _registryOf: () => MessageHandlerRegistry;
  private readonly _gate: InboundCallGate;
  private readonly _responseEffectQueue: ResponseEffectQueue;

  constructor(context: InboundCallsV16Context) {
    this._chargePoint = context.chargePoint;
    this._webSocket = context.webSocket;
    this._logger = context.logger;
    this._registryOf = context.registry;
    this._gate = context.gate;
    this._responseEffectQueue = context.responseEffectQueue;
  }

  private get _registry(): MessageHandlerRegistry {
    return this._registryOf();
  }

  public async handleCall(
    messageId: string,
    action: OCPPAction,
    payload: OcppMessagePayloadCall,
  ): Promise<void> {
    behaviorTapOf(this._chargePoint).observe({
      type: "callReceived",
      action,
      messageId,
      payload,
    });
    // Capture the generation at dispatch time (before the await) so a response
    // produced by an async handler settles against its originating generation.
    const gen = this._webSocket.currentGeneration();
    const exchange = this.openExchange(messageId, action, gen);

    // The gate announces the CALL (issue #110, #396: csmsCallTrigger nodes and
    // the control plane), then applies the inbound policy (#247, sticky) and a
    // one-shot response override (#110; it replaces the handler entirely, so
    // the legacy remoteStartReceived/remoteStopReceived delegation never fires
    // — scenarios combining an override with a wait must use the generic
    // csmsCallTrigger). Every answer reports itself through the exchange.
    if (this._gate.admit(exchange, payload).kind === "settled") return;

    // Use registry to get handler
    const handler = this._registry.getCallHandler(action);

    if (!handler) {
      this._logger.error(`Unsupported action: ${action}`, LogType.OCPP);
      exchange.replyError(
        OCPPErrorCodeV16.NotImplemented,
        "This action is not supported",
      );
      return;
    }

    // The gate has run: policies, overrides and behavior rules may own a
    // malformed CALL (docs/concepts/call-precedence.md); validation guards
    // only what reaches the default handler (#593).
    const mode = this._chargePoint.inboundValidation;
    if (mode !== "off") {
      const violation = inboundV16Violation(action, payload);
      if (violation) {
        const message = `Inbound ${action} ${violation.errorCode}: ${violation.description}`;
        // Structured line for the trace (`meta.validation` on the CALL's
        // record, packages/trace). It goes out on the WebSocket channel the
        // trace writer already follows, before the handler or the error reply.
        this._logger.warn(
          `Inbound validation: ${JSON.stringify({
            messageId,
            action,
            mode,
            errorCode: violation.errorCode,
            description: violation.description,
          })}`,
          LogType.WEBSOCKET,
        );
        if (mode === "enforce") {
          this._logger.warn(message, LogType.OCPP);
          exchange.replyError(violation.errorCode, violation.description);
          return;
        }
        this._logger.warn(`${message} (handler still runs)`, LogType.OCPP);
      }
    }

    try {
      const context: HandlerContext = {
        chargePoint: this._chargePoint,
        logger: this._logger,
      };
      // `handle()` may return its response synchronously or as a Promise
      // (see `CallHandler` in MessageHandlerRegistry.ts) — `await` resolves
      // a plain value immediately, so this is a no-op for sync handlers.
      const rawResult = await handler.handle(payload, context);
      const { payload: normalizedPayload, effect } = normalizeHandlerResult(
        rawResult as HandlerResult,
      );
      exchange.reply(normalizedPayload, {
        ...(effect ? { effect } : {}),
      });
    } catch (error) {
      if (error instanceof HandlerCallError) {
        this._logger.warn(
          `${action} answered with CALLERROR ${error.errorCode}: ${error.description}`,
          LogType.OCPP,
        );
        if (exchange.state === "open") {
          exchange.replyError(error.errorCode, error.description);
        }
        return;
      }
      this._logger.error(`Error handling ${action}: ${error}`, LogType.OCPP);
      if (exchange.state === "open") {
        exchange.replyError(OCPPErrorCodeV16.InternalError, String(error));
      }
    }
  }

  /** The exchange of one inbound CALL, bound to this socket's generation. */
  private openExchange(
    messageId: string,
    action: string,
    generation: GenerationToken,
  ): CallExchange {
    const exchange = new CallExchange({
      action,
      messageId,
      generation,
      isGenerationCurrent: (g) =>
        g.gen === this._webSocket.currentGeneration().gen,
      announce: (completion) =>
        this._chargePoint.notifyIncomingCallCompleted(completion),
      writeResult: (payload, gen, onSettled) =>
        this._webSocket.sendResult(messageId, payload, gen, onSettled),
      writeError: (errorCode, errorDescription, gen, onSettled, details) =>
        this._webSocket.sendError(
          messageId,
          {
            errorCode: errorCode as OCPPErrorCode,
            errorDescription,
            ...(details === undefined ? {} : { errorDetails: details }),
          },
          gen,
          onSettled,
        ),
      writeRaw: (frame, gen, onSettled) =>
        this._webSocket.sendRaw(frame, gen, onSettled),
      schedule: (delayMs, callback) => {
        this._chargePoint.clock.setTimeout(callback, delayMs);
      },
      effects: this._responseEffectQueue,
      warn: (message) => this._logger.warn(message, LogType.OCPP),
    });
    this._gate.track(exchange);
    return exchange;
  }
}
