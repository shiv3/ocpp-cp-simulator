import {
  OCPP_CALL_RESPONSE_TIMEOUT_MS,
  type OcppCallOutcome,
  type OcppCallRequest,
} from "../../domain/types/OcppCall";
import { OcppCallNoAnswerError } from "../../domain/errors/OcppCallErrors";
import { CallWaiters } from "./CallWaiters";
import { encodeCallFrame } from "./callFrame";

/** The fields of a CALLERROR, as a CSMS may (not) send them. */
export interface CallErrorFields {
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly errorDetails?: unknown;
}

/**
 * The expert calls (#389) a handler has in flight. Both JSON handlers route
 * every CALLRESULT / CALLERROR through `claimResult` / `claimError` first: an
 * expert call's answer resolves its caller, and unless the caller asked to
 * `applyResponse` the claim says the answer stops there, before any station
 * state changes.
 *
 * When the caller's wait expires, `withdraw` asks the handler to take the
 * CALL back if it has not gone out yet (1.6 queues CALLs behind the one in
 * flight): a CALL whose caller was told "no answer" must not be sent later.
 * A CALL already written keeps its id, so a late answer is still recognised
 * as an expert one and kept away from the domain handlers.
 */
export class ExpertCalls {
  private readonly _calls = new Map<
    string,
    { readonly sentFrame: string; readonly applyResponse: boolean }
  >();
  private readonly _waiters = new CallWaiters<OcppCallOutcome>(
    OCPP_CALL_RESPONSE_TIMEOUT_MS,
    (id) => {
      if (this._withdraw(id)) this._calls.delete(id);
      return new OcppCallNoAnswerError(
        "timeout",
        `OCPP call ${id}: no answer within ${OCPP_CALL_RESPONSE_TIMEOUT_MS}ms`,
      );
    },
  );

  /** `withdraw(id)` removes the CALL if it is still unsent and says so. */
  constructor(private readonly _withdraw: (messageId: string) => boolean) {}

  /** Track a CALL about to be sent under `messageId`; resolves with the
   *  CSMS's answer. */
  start(messageId: string, request: OcppCallRequest): Promise<OcppCallOutcome> {
    const sentFrame = encodeCallFrame(
      messageId,
      request.action,
      request.payload,
    );
    this._calls.set(messageId, {
      sentFrame,
      applyResponse: request.applyResponse ?? false,
    });
    return this._waiters.register(messageId);
  }

  /** Settle the caller of an expert call answered with a CALLRESULT. True
   *  when the answer stops here: an expert call without `applyResponse`. */
  claimResult(messageId: string, payload: unknown): boolean {
    return this.claim(messageId, (sentFrame) => ({
      kind: "callResult",
      messageId,
      sentFrame,
      payload,
    }));
  }

  /** As {@link claimResult}, for a CALLERROR. */
  claimError(messageId: string, error: CallErrorFields): boolean {
    return this.claim(messageId, (sentFrame) => ({
      kind: "callError",
      messageId,
      sentFrame,
      // A non-conformant CSMS may send other types; the answer is shown as
      // received, but these two stay strings.
      errorCode: String(error.errorCode ?? ""),
      errorDescription: String(error.errorDescription ?? ""),
      errorDetails: error.errorDetails ?? {},
    }));
  }

  /** The CALL never reached the wire. */
  onDropped(messageId: string, reason: string): void {
    if (!this.take(messageId)) return;
    this._waiters.reject(
      messageId,
      new OcppCallNoAnswerError(
        "dropped",
        `OCPP call ${messageId} dropped (${reason})`,
      ),
    );
  }

  /** No answer can come back over a closed socket. */
  onClosed(): void {
    this._calls.clear();
    this._waiters.rejectAll(
      (id) =>
        new OcppCallNoAnswerError(
          "dropped",
          `OCPP call ${id} dropped (socket_closed)`,
        ),
    );
  }

  private claim(
    messageId: string,
    outcome: (sentFrame: string) => OcppCallOutcome,
  ): boolean {
    const call = this.take(messageId);
    if (!call) return false;
    this._waiters.resolve(messageId, outcome(call.sentFrame));
    return !call.applyResponse;
  }

  private take(messageId: string) {
    const call = this._calls.get(messageId);
    this._calls.delete(messageId);
    return call;
  }
}
