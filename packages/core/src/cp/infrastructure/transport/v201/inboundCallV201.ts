// Inbound CALL handling of OCPPMessageHandlerV201 (#877): the gate, the
// registry lookup, validation and the answer through the exchange.
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { OCPPErrorCode } from "../../../domain/types/OcppTypes";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import { behaviorTapOf } from "../behaviorTap";
import { inboundV2xViolation } from "../codec/validateV2x";
import { CallExchange } from "../inbound/CallExchange";
import type { InboundCallGate } from "../inbound/InboundCallGate";
import type { GenerationToken, ResponseEffectQueue } from "../network-sim";
import type { CertificateSigningV201 } from "./certificateSigningV201";
import type {
  V201Action,
  V201HandlerResult,
  V201InboundContext,
  V201InboundRegistry,
  V201RequestPayload,
} from "./inboundRegistryV201";

/** True for a promise or any other thenable a handler may return. */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/** What the handler itself keeps for the inbound CALLs. */
export interface InboundCallsV201Host {
  send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void;
  generateMessageId(): string;
  hasTransactionEventsToDeliver(transactionId?: string): boolean;
  bootAccepted(): boolean;
}

export interface InboundCallsV201Context {
  readonly chargePoint: ChargePoint;
  readonly webSocket: OCPPWebSocket;
  readonly logger: Logger;
  readonly inbound: V201InboundRegistry;
  readonly gate: InboundCallGate;
  readonly responseEffectQueue: ResponseEffectQueue;
  readonly certificates: CertificateSigningV201;
  readonly host: InboundCallsV201Host;
}

export class InboundCallsV201 {
  private readonly _chargePoint: ChargePoint;
  private readonly _webSocket: OCPPWebSocket;
  private readonly _logger: Logger;
  private readonly _inbound: V201InboundRegistry;
  private readonly _gate: InboundCallGate;
  private readonly _responseEffectQueue: ResponseEffectQueue;
  private readonly _certificates: CertificateSigningV201;
  private readonly _host: InboundCallsV201Host;

  constructor(context: InboundCallsV201Context) {
    this._chargePoint = context.chargePoint;
    this._webSocket = context.webSocket;
    this._logger = context.logger;
    this._inbound = context.inbound;
    this._gate = context.gate;
    this._responseEffectQueue = context.responseEffectQueue;
    this._certificates = context.certificates;
    this._host = context.host;
  }

  public handleCall(messageId: string, action: string, payload: unknown): void {
    // #349: the scenario mechanisms the 1.6 handler consults at this point —
    // the csmsCallTrigger event, inbound policies and one-shot response
    // overrides — apply on 2.0.1 too, through the one gate both handlers
    // share. Scenarios spell actions in either version's vocabulary; a
    // 2.0.1 CALL is looked up under its own name and its 1.6 alias
    // (RequestStartTransaction ← RemoteStartTransaction, …).
    // #396: the control plane announces the CALL under its wire name;
    // every answer below reports itself through the exchange.
    behaviorTapOf(this._chargePoint).observe({
      type: "callReceived",
      action,
      messageId,
      payload,
    });
    const gen = this._webSocket.currentGeneration();
    const exchange = this.openExchange(messageId, action, gen);
    if (this._gate.admit(exchange, payload).kind === "settled") return;

    const entry = this._inbound.get(action);
    if (entry) {
      if (!entry.validate(payload)) {
        // Part 4 §4.3 Table 8: the code names the kind of violation.
        const violation = inboundV2xViolation(
          action,
          payload,
          this._chargePoint.ocppVersion,
        );
        exchange.replyError(violation.errorCode, violation.description);
        return;
      }

      const ctx: V201InboundContext = {
        chargePoint: this._chargePoint,
        logger: this._logger,
        sendCall: (a, p) =>
          this._host.send(a, this._host.generateMessageId(), p),
        hasTransactionEventsToDeliver: (id) =>
          this._host.hasTransactionEventsToDeliver(id),
        certificateSigning: this._certificates.certificateSigning,
        bootAccepted: () => this._host.bootAccepted(),
      };
      const fail = (error: unknown): void => {
        // The exchange refuses an answer on a connection that changed (and
        // runs no afterResult); that case needs no CALLERROR.
        if (exchange.state !== "open") return;
        // Same answer as the 1.6J handler: a failing handler is the
        // station's fault, so the CSMS gets InternalError instead of
        // waiting for its timeout (#399).
        this._logger.error(
          `[v2.0.1] Error handling ${action}: ${error}`,
          LogType.OCPP,
        );
        exchange.replyError(
          "InternalError",
          // OCPP-J 2.0.1 / 2.1 Part 4 §4.2.3: ErrorDescription is
          // string[255].
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            255,
          ),
        );
      };
      const finish = ({
        response,
        afterResult,
        callError,
      }: V201HandlerResult): void => {
        if (callError) {
          exchange.replyError(callError.code, callError.description);
          return;
        }
        exchange.reply(response, {
          ...(afterResult ? { effect: afterResult } : {}),
        });
      };
      let handled: ReturnType<typeof entry.handle>;
      try {
        handled = entry.handle(payload, ctx);
      } catch (error) {
        fail(error);
        return;
      }
      // #456: await only a real thenable. An unconditional await would
      // defer every CALLRESULT by a microtask and reorder it against the
      // follow-up CALLs other code sends meanwhile. `Promise.resolve`
      // adopts any thenable, including one whose `then` returns nothing.
      if (isThenable(handled)) {
        Promise.resolve(handled)
          .then(finish, fail)
          .catch((error: unknown) =>
            this._logger.error(
              `[v2.0.1] Error answering ${action}: ${error}`,
              LogType.OCPP,
            ),
          );
        return;
      }
      finish(handled);
      return;
    }

    this._logger.warn(
      `[v2.0.1] Unsupported CSMS action ${action}`,
      LogType.OCPP,
    );
    exchange.replyError("NotImplemented", "This action is not supported");
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
      writeError: (errorCode, errorDescription, gen, onSettled) =>
        this._webSocket.sendError(
          messageId,
          {
            errorCode: errorCode as OCPPErrorCode,
            errorDescription,
            errorDetails: {},
          },
          gen,
          onSettled,
        ),
      effects: this._responseEffectQueue,
      warn: (message) =>
        this._logger.warn(
          message.startsWith("[v2.0.1]") ? message : `[v2.0.1] ${message}`,
          LogType.OCPP,
        ),
    });
    this._gate.track(exchange);
    return exchange;
  }
}
