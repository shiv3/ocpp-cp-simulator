import { CallWaiters } from "./CallWaiters";
import { platformClock, type RpcClock } from "./platformClock";
import type { RpcDialect } from "./dialects";
import {
  decodeFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
  type RpcCallFrame,
  type RpcDecodeErrorReason,
} from "./frames";
import type { RpcValidator } from "./validation";

/** The answer to a CALL the peer sent: a CALLRESULT payload. */
export type RpcHandler = (
  payload: unknown,
  context: { readonly messageId: string; readonly action: string },
) => unknown;

/** A frame the endpoint could not use, never answered (see #978: the
 *  spec-conformant replies are #1060), or an answer `send` could not write. */
export interface RpcProtocolProblem {
  readonly reason:
    RpcDecodeErrorReason | "unmatched-response" | "reply-send-failed";
  readonly raw: string;
  readonly messageId?: string;
}

export interface RpcEndpointOptions {
  /** Writes one text frame to the peer. A throw rejects the call being sent,
   *  or is reported as `reply-send-failed` for an answer. */
  readonly send: (frame: string) => void;
  /** The id of the next outgoing CALL; never reused for the endpoint's
   *  lifetime, timed-out calls included, so a late answer to an old call
   *  cannot settle a newer one. */
  readonly nextMessageId: () => string;
  /** The version's error codes. */
  readonly dialect: RpcDialect;
  /** Timers for call timeouts. Defaults to the platform timers. */
  readonly clock?: RpcClock;
  /** How long a call waits for its answer. Defaults to 30 s. */
  readonly callTimeoutMs?: number;
  /** Checks inbound CALL requests and CALLRESULT responses. */
  readonly validate?: RpcValidator;
  /** Told about every malformed or unmatched frame. */
  readonly onProtocolError?: (problem: RpcProtocolProblem) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Thrown by a handler to answer with a CALLERROR of its choosing. */
export class RpcHandlerError extends Error {
  constructor(
    readonly errorCode: string,
    readonly errorDescription: string,
    readonly errorDetails?: object,
  ) {
    super(`${errorCode}: ${errorDescription}`);
    this.name = "RpcHandlerError";
  }
}

/** The peer answered a call with a CALLERROR. */
export class RpcCallError extends Error {
  constructor(
    readonly action: string,
    readonly messageId: string,
    readonly errorCode: string,
    readonly errorDescription: string,
    readonly errorDetails: unknown,
  ) {
    super(`${action} (${messageId}): ${errorCode} ${errorDescription}`);
    this.name = "RpcCallError";
  }
}

/** The peer's CALLRESULT failed validation. `errorCode` is the dialect's code
 *  for the violation; nothing is sent back. */
export class RpcInvalidResponseError extends Error {
  constructor(
    readonly action: string,
    readonly messageId: string,
    readonly errorCode: string,
    readonly description: string,
  ) {
    super(`${action} (${messageId}): ${errorCode} ${description}`);
    this.name = "RpcInvalidResponseError";
  }
}

/** No answer within the call timeout. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly action: string,
    readonly messageId: string,
    readonly timeoutMs: number,
  ) {
    super(`${action} (${messageId}): no answer within ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

/** The endpoint was closed before the call was answered. */
export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RpcClosedError";
  }
}

/**
 * One side of an OCPP-J connection, charging station or CSMS alike: it sends
 * CALLs and correlates their answers, and answers the CALLs it receives with
 * the registered handlers. It owns no socket: `send` and `receive` are the
 * whole link.
 */
export class RpcEndpoint {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly actions = new Map<string, string>();
  private readonly waiters: CallWaiters<unknown>;
  private readonly clock: RpcClock;
  private readonly timeoutMs: number;
  private closed: string | null = null;

  constructor(private readonly options: RpcEndpointOptions) {
    this.clock = options.clock ?? platformClock;
    this.timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.waiters = new CallWaiters<unknown>(
      this.timeoutMs,
      (id) => {
        const action = this.actions.get(id) ?? "";
        this.actions.delete(id);
        return new RpcTimeoutError(action, id, this.timeoutMs);
      },
      () => this.clock,
    );
  }

  /** Answer CALLs for `action` with `handler`; replaces an earlier one. */
  handle(action: string, handler: RpcHandler): void {
    this.handlers.set(action, handler);
  }

  /** Send a CALL; resolves with the CALLRESULT payload. */
  call(action: string, payload: unknown): Promise<unknown> {
    if (this.closed !== null)
      return Promise.reject(new RpcClosedError(this.closed));
    const id = this.options.nextMessageId();
    this.actions.set(id, action);
    const answer = this.waiters.register(id);
    try {
      this.options.send(encodeCall(id, action, payload));
    } catch (error) {
      this.settle(id);
      this.waiters.reject(
        id,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return answer;
  }

  /** Take one text frame from the peer. */
  receive(raw: string): void {
    if (this.closed !== null) return;
    const frame = decodeFrame(raw);
    switch (frame.kind) {
      case "invalid":
        this.problem(frame);
        return;
      case "call":
        void this.answer(frame);
        return;
      case "callResult": {
        const action = this.settle(frame.messageId);
        if (action === undefined) return this.unmatched(raw, frame.messageId);
        const violation = this.options.validate?.({
          direction: "response",
          action,
          payload: frame.payload,
        });
        if (violation) {
          this.waiters.reject(
            frame.messageId,
            new RpcInvalidResponseError(
              action,
              frame.messageId,
              this.options.dialect.violationCodes[violation.kind],
              violation.description,
            ),
          );
          return;
        }
        this.waiters.resolve(frame.messageId, frame.payload);
        return;
      }
      case "callError": {
        const action = this.settle(frame.messageId);
        if (action === undefined) return this.unmatched(raw, frame.messageId);
        this.waiters.reject(
          frame.messageId,
          new RpcCallError(
            action,
            frame.messageId,
            frame.errorCode,
            frame.errorDescription,
            frame.errorDetails,
          ),
        );
        return;
      }
    }
  }

  /** Reject every call in flight and stop sending and receiving. */
  close(reason = "RPC endpoint closed"): void {
    if (this.closed !== null) return;
    this.closed = reason;
    this.actions.clear();
    this.waiters.rejectAll(() => new RpcClosedError(reason));
  }

  private async answer(frame: RpcCallFrame): Promise<void> {
    const { messageId, action, payload } = frame;
    const { dialect, validate } = this.options;
    const handler = this.handlers.get(action);
    if (!handler) {
      this.reply(
        messageId,
        encodeCallError(
          messageId,
          dialect.notImplemented,
          `No handler for ${action}`,
        ),
      );
      return;
    }
    const violation = validate?.({ direction: "request", action, payload });
    if (violation) {
      this.reply(
        messageId,
        encodeCallError(
          messageId,
          dialect.violationCodes[violation.kind],
          violation.description,
        ),
      );
      return;
    }
    let answer: string;
    try {
      // An answer that cannot be encoded (a cycle, a BigInt) counts as a
      // handler failure.
      answer = encodeCallResult(
        messageId,
        await handler(payload, { messageId, action }),
      );
    } catch (error) {
      answer = this.failureFrame(messageId, action, error);
    }
    this.reply(messageId, answer);
  }

  /** The CALLERROR for a handler that threw: its own for an
   *  `RpcHandlerError` whose details can be encoded, else `InternalError`. */
  private failureFrame(
    messageId: string,
    action: string,
    error: unknown,
  ): string {
    if (error instanceof RpcHandlerError) {
      try {
        return encodeCallError(
          messageId,
          error.errorCode,
          error.errorDescription,
          error.errorDetails,
        );
      } catch {
        // Details that cannot be encoded: fall through to InternalError.
      }
    }
    return encodeCallError(
      messageId,
      this.options.dialect.internalError,
      `Handler for ${action} failed`,
    );
  }

  private reply(messageId: string, frame: string): void {
    if (this.closed !== null) return;
    try {
      this.options.send(frame);
    } catch {
      // Nobody awaits an answer; the peer's own call timeout covers it.
      this.problem({ reason: "reply-send-failed", raw: frame, messageId });
    }
  }

  /** The action of the call in flight under `id`, forgotten from now on. */
  private settle(id: string): string | undefined {
    if (!this.waiters.has(id)) return undefined;
    const action = this.actions.get(id);
    this.actions.delete(id);
    return action;
  }

  private unmatched(raw: string, messageId: string): void {
    this.problem({ reason: "unmatched-response", raw, messageId });
  }

  private problem(problem: RpcProtocolProblem): void {
    this.options.onProtocolError?.(
      problem.messageId === undefined
        ? { reason: problem.reason, raw: problem.raw }
        : {
            reason: problem.reason,
            raw: problem.raw,
            messageId: problem.messageId,
          },
    );
  }
}
