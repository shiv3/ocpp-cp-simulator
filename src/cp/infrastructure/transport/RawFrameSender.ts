import {
  OCPP_CALL_RESPONSE_TIMEOUT_MS,
  RAW_FRAME_DEFAULT_WAIT_MS,
  type RawFrameOutcome,
  type RawFrameRequest,
} from "../../domain/types/OcppCall";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../domain/errors/OcppCallErrors";
import { OCPPMessageType } from "../../domain/types/OcppTypes";
import type { OCPPWebSocket } from "./OCPPWebSocket";

type Waiter = {
  readonly messageId: string | null;
  /** Set once the frame is on the wire; only then can a reply answer it. */
  armed: boolean;
  readonly settle: (reply: unknown[] | null, closed: string | null) => void;
  readonly fail: (error: Error) => void;
};

/** The ids a CSMS answers an unreadable frame with (OCPP-J §4.2.3 leaves it
 *  open; `""` and `"-1"` are what implementations send). */
const UNREADABLE_FRAME_IDS = new Set(["", "-1"]);

/**
 * #393: level C expert sends. The frame goes through the transport's
 * `sendRaw`, so logging and network simulation are shared with normal
 * traffic, but it bypasses the 1.6 one-CALL-in-flight queue: a frame that is
 * not a CALL may never be answered, and holding the slot for it would stall
 * normal traffic. It may therefore overlap an in-flight CALL.
 *
 * Replies are correlated best effort and consumed here, so they never reach
 * the station's handlers. The wait runs from the moment the transport takes
 * the frame, so a network-sim delay counts against it and the call returns
 * within `waitMs` (at most 25 s, under the 30 s RPC deadline). A frame still
 * queued when the wait ends is written later; nothing cancels it.
 */
export class RawFrameSender {
  private readonly _waiters = new Set<Waiter>();

  constructor(private readonly _webSocket: OCPPWebSocket) {
    _webSocket.setIncomingInterceptor((frame) => this.intercept(frame));
    _webSocket.observers.on("closed", ({ cause }) => {
      for (const waiter of [...this._waiters]) waiter.settle(null, cause);
    });
  }

  send(request: RawFrameRequest): Promise<RawFrameOutcome> {
    const { frame } = request;
    if (typeof frame !== "string") {
      return Promise.reject(
        new OcppCallRejectedError(
          "invalid_payload",
          "A raw frame must be a string",
        ),
      );
    }
    if (!this._webSocket.isConnected()) {
      return Promise.reject(
        new OcppCallRejectedError(
          "not_connected",
          "A raw frame needs an open WebSocket",
        ),
      );
    }
    const waitMs = Math.min(
      Math.max(0, request.waitMs ?? RAW_FRAME_DEFAULT_WAIT_MS),
      OCPP_CALL_RESPONSE_TIMEOUT_MS,
    );
    const messageId = messageIdOf(frame);

    return new Promise((resolve, reject) => {
      const finish = (): boolean => {
        if (!this._waiters.delete(waiter)) return false;
        clearTimeout(timer);
        return true;
      };
      const waiter: Waiter = {
        messageId,
        armed: false,
        settle: (reply, closed) => {
          if (finish()) resolve({ sentFrame: frame, messageId, reply, closed });
        },
        fail: (error) => {
          if (finish()) reject(error);
        },
      };
      const timer = setTimeout(() => waiter.settle(null, null), waitMs);
      this._waiters.add(waiter);
      this._webSocket.sendRaw(
        frame,
        this._webSocket.currentGeneration(),
        (settlement) => {
          if (settlement.outcome === "written") {
            waiter.armed = true;
          } else if (settlement.outcome === "socket_closed") {
            waiter.settle(null, settlement.closeCause ?? "network");
          } else {
            // Not written while the socket stayed open (a full network-sim
            // queue, a failed write) or the transport was disposed: not a
            // close, so not reported in `closed`.
            waiter.fail(
              new OcppCallNoAnswerError(
                "dropped",
                `The raw frame was not written (${settlement.outcome})`,
              ),
            );
          }
        },
      );
    });
  }

  /** Consumes a CALLRESULT / CALLERROR answering a pending raw frame. */
  private intercept(frame: unknown[]): boolean {
    if (this._waiters.size === 0) return false;
    const [type, id] = frame;
    const isResult = type === OCPPMessageType.CALLRESULT && frame.length === 3;
    const isError = type === OCPPMessageType.CALLERROR && frame.length === 5;
    if (!isResult && !isError) return false;
    for (const waiter of this._waiters) {
      if (!waiter.armed) continue;
      if (
        (waiter.messageId !== null && id === waiter.messageId) ||
        (isError && typeof id === "string" && UNREADABLE_FRAME_IDS.has(id))
      ) {
        waiter.settle(frame, null);
        return true;
      }
    }
    return false;
  }
}

function messageIdOf(frame: string): string | null {
  try {
    const parsed: unknown = JSON.parse(frame);
    return Array.isArray(parsed) && typeof parsed[1] === "string"
      ? parsed[1]
      : null;
  } catch {
    return null;
  }
}
