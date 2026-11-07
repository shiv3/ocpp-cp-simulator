import type { IncomingCallCompletion } from "../../../domain/charge-point/ChargePointEvents";
import type { GenerationToken } from "../network-sim/NetworkSimController";
import type {
  FrameDropReason,
  Settlement,
} from "../network-sim/NetworkSimPipeline";
import type {
  EffectDroppedHandler,
  ResponseEffectQueue,
} from "../network-sim/ResponseEffectQueue";

/** Where an exchange is in its life; see {@link CallExchange}. */
export type ExchangeState = "open" | "answered" | "suppressed" | "abandoned";

/** Why an answer did not reach the CSMS. */
export type ExchangeDropReason =
  | FrameDropReason
  /** The connection changed first, or the exchange was abandoned. */
  | "stale"
  /** The exchange was suppressed: nothing was meant to be sent. */
  | "suppressed";

/** How an answer ended. Always resolves, never rejects. */
export type ExchangeSettlement =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: ExchangeDropReason };

export class CallExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallExchangeError";
  }
}

export interface AnswerOptions {
  /**
   * Work that follows the answer once the transport settled it; it runs under
   * the rules of the {@link ResponseEffectQueue} (not on a stale connection,
   * not after a station-initiated close).
   */
  readonly effect?: () => void;
  /** Told once if `effect` will not run. */
  readonly onEffectDropped?: EffectDroppedHandler;
}

/** What an exchange needs from the adapter that owns the socket. */
export interface CallExchangeDeps {
  readonly action: string;
  readonly messageId: string;
  /** The connection generation the CALL arrived on. */
  readonly generation: GenerationToken;
  isGenerationCurrent(generation: GenerationToken): boolean;
  /** Announce the chosen answer (`incomingCallCompleted`), before the transport sees it. */
  announce(completion: IncomingCallCompletion): void;
  /** Hand a CALLRESULT to the transport. */
  writeResult(
    payload: unknown,
    generation: GenerationToken,
    onSettled: ((settlement: Settlement) => void) | undefined,
  ): void;
  /** Hand a CALLERROR to the transport. */
  writeError(
    errorCode: string,
    errorDescription: string,
    generation: GenerationToken,
    onSettled: ((settlement: Settlement) => void) | undefined,
  ): void;
  readonly effects: ResponseEffectQueue;
  warn(message: string): void;
}

/**
 * One inbound CSMS CALL and its single answer (docs/analyses/charger-engine.md,
 * "CallExchange and InboundCallGate").
 *
 * - `open`: nothing decided yet.
 * - `answered`: a CALLRESULT or CALLERROR was handed to the transport.
 * - `suppressed`: the CALL is left unanswered on purpose (an `ignore` policy,
 *   a `none` answer).
 * - `abandoned`: the connection changed before an answer: nothing is sent.
 *
 * The first answer is sent; a second one is not sent and throws
 * {@link CallExchangeError}. Every answer is synchronous up to the transport,
 * never deferred by a microtask (#456); the promise it returns only reports
 * how it ended.
 *
 * Two ways to answer. {@link CallExchange.respond} / `respondError` observe the
 * answer: the transport is given a settlement hook and the returned promise
 * says whether the frame was written. {@link CallExchange.reply} /
 * `replyError` do not: no hook is given to the transport unless the answer
 * carries an effect, which keeps the default path exactly as it was (a frame
 * that was dropped with no hook is logged by the transport as a discard).
 */
export class CallExchange {
  private _state: ExchangeState = "open";
  private readonly closedListeners: Array<() => void> = [];
  private resolveSettled!: (settlement: ExchangeSettlement) => void;
  /**
   * How the exchange ended: the outcome of an observed answer (`respond`,
   * `respondError`), `suppressed`, or `stale` when abandoned. An unobserved
   * `reply` never resolves it.
   */
  readonly settled: Promise<ExchangeSettlement>;

  constructor(private readonly deps: CallExchangeDeps) {
    this.settled = new Promise<ExchangeSettlement>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  /**
   * Call `listener` once the exchange leaves `open` (answered, suppressed or
   * abandoned); at once if it already has. For bookkeeping that follows open
   * exchanges.
   */
  onClosed(listener: () => void): void {
    if (this._state !== "open") listener();
    else this.closedListeners.push(listener);
  }

  private closed(): void {
    for (const listener of this.closedListeners.splice(0)) listener();
  }

  get state(): ExchangeState {
    return this._state;
  }

  get action(): string {
    return this.deps.action;
  }

  get messageId(): string {
    return this.deps.messageId;
  }

  /** Answer with a CALLRESULT and observe how it ended. */
  respond(
    payload: unknown,
    options: AnswerOptions = {},
  ): Promise<ExchangeSettlement> {
    return this.answerResult(payload, options, true);
  }

  /** Answer with a CALLERROR and observe how it ended. */
  respondError(
    errorCode: string,
    errorDescription: string,
    options: AnswerOptions = {},
  ): Promise<ExchangeSettlement> {
    return this.answerError(errorCode, errorDescription, options, true);
  }

  /** Answer with a CALLRESULT without observing it (see the class comment). */
  reply(payload: unknown, options: AnswerOptions = {}): void {
    void this.answerResult(payload, options, false);
  }

  /** Answer with a CALLERROR without observing it (see the class comment). */
  replyError(
    errorCode: string,
    errorDescription: string,
    options: AnswerOptions = {},
  ): void {
    void this.answerError(errorCode, errorDescription, options, false);
  }

  private answerResult(
    payload: unknown,
    options: AnswerOptions,
    observe: boolean,
  ): Promise<ExchangeSettlement> {
    return this.answer(
      { outcome: "CallResult" },
      options,
      observe,
      (onSettled) =>
        this.deps.writeResult(payload, this.deps.generation, onSettled),
    );
  }

  private answerError(
    errorCode: string,
    errorDescription: string,
    options: AnswerOptions,
    observe: boolean,
  ): Promise<ExchangeSettlement> {
    return this.answer(
      { outcome: "CallError", errorCode },
      options,
      observe,
      (onSettled) =>
        this.deps.writeError(
          errorCode,
          errorDescription,
          this.deps.generation,
          onSettled,
        ),
    );
  }

  /** Leave the CALL unanswered on purpose. */
  suppress(): Promise<ExchangeSettlement> {
    this.requireNotAnswered();
    if (this._state === "abandoned") return this.settled;
    this._state = "suppressed";
    this.deps.announce({
      action: this.deps.action,
      messageId: this.deps.messageId,
      outcome: "NoResponse",
    });
    this.resolveSettled({ delivered: false, reason: "suppressed" });
    this.closed();
    return this.settled;
  }

  /**
   * The connection went away before an answer. Nothing is sent, ever, for
   * this CALL; an answer that comes later settles `stale`. Does nothing once
   * the exchange is no longer open.
   */
  abandon(): void {
    if (this._state !== "open") return;
    this._state = "abandoned";
    this.deps.announce({
      action: this.deps.action,
      messageId: this.deps.messageId,
      outcome: "NoResponse",
    });
    this.resolveSettled({ delivered: false, reason: "stale" });
    this.closed();
  }

  private requireNotAnswered(): void {
    if (this._state === "answered" || this._state === "suppressed") {
      throw new CallExchangeError(
        `${this.deps.action} ${this.deps.messageId} is already ${this._state}; a CALL gets one answer`,
      );
    }
  }

  private answer(
    completion:
      { outcome: "CallResult" } | { outcome: "CallError"; errorCode: string },
    options: AnswerOptions,
    observe: boolean,
    write: (onSettled: ((settlement: Settlement) => void) | undefined) => void,
  ): Promise<ExchangeSettlement> {
    this.requireNotAnswered();
    if (this._state === "abandoned") {
      options.onEffectDropped?.("stale");
      return this.settled;
    }
    if (!this.deps.isGenerationCurrent(this.deps.generation)) {
      this.deps.warn(
        `${this.deps.action} answered after the connection changed; not sent`,
      );
      this.abandon();
      options.onEffectDropped?.("stale");
      return this.settled;
    }

    const effectSettled = options.effect
      ? this.deps.effects.register(
          this.deps.generation,
          options.effect,
          options.onEffectDropped,
        )
      : undefined;
    // Announced while still open: a subscriber that throws leaves the CALL
    // unanswered for the caller to answer with a CALLERROR.
    this.deps.announce({
      action: this.deps.action,
      messageId: this.deps.messageId,
      ...completion,
    });
    this._state = "answered";
    this.closed();
    let reported = false;
    // Without an observer and without an effect nothing listens, and the
    // transport gets no hook at all.
    const onSettled =
      observe || effectSettled
        ? (settlement: Settlement): void => {
            if (reported) return;
            reported = true;
            try {
              effectSettled?.(settlement);
            } finally {
              this.resolveSettled(
                settlement.outcome === "written"
                  ? { delivered: true }
                  : { delivered: false, reason: settlement.outcome },
              );
            }
          }
        : undefined;
    try {
      write(onSettled);
    } catch (error) {
      // Nothing reached the transport, so the CALL is still unanswered: the
      // caller may answer it another way (a CALLERROR for the failure).
      this._state = "open";
      reported = true;
      throw error;
    }
    return this.settled;
  }
}
