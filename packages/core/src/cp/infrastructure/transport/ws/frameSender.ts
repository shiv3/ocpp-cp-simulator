// Split out of OCPPWebSocket (#877): reaches the socket only through `host`.
import { encodeCallFrame } from "../callFrame";
import {
  encodeCallError,
  encodeCallResult,
} from "@ocpp-cp-simulator/ocpp-rpc/index";
import { type GenerationToken, type Settlement } from "../network-sim";
import { type OcppMessageErrorPayload } from "../OCPPWebSocket";
import type { OcppWebSocketHost } from "./socketHost";

export class FrameSender {
  constructor(private readonly host: OcppWebSocketHost) {}

  public sendAction(
    messageId: string,
    action: string,
    payload: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    // Stale generation check
    if (gen.gen !== this.host.currentGeneration.gen) {
      // Stale generation: sendAction returns false, onSettled does NOT fire
      return false;
    }

    // Socket-open gate: spec section 2.5 requires send-false when socket is not open
    if (!this.host.isConnected()) {
      return false;
    }

    return this.host.controller.sendUpstream(
      encodeCallFrame(messageId, action, payload),
      onSettled,
    );
  }

  public sendResult(
    messageId: string,
    payload: unknown,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Stale generation check
    if (gen.gen !== this.host.currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: gen.closeCause ?? "network",
      };
      onSettled?.(settlement);
      return;
    }

    // Socket-open gate: spec section 2.5 requires settlement when socket is not open
    if (!this.host.isConnected()) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause: this.host.currentGeneration.closeCause ?? "network",
      });
      return;
    }

    const message = encodeCallResult(messageId, payload);
    const accepted = this.host.controller.sendUpstream(message, onSettled);

    // If sendUpstream returns false (overflow/stopped), settle immediately with queue_overflow
    if (!accepted && onSettled) {
      const settlement: Settlement = { outcome: "queue_overflow" };
      try {
        onSettled(settlement);
      } catch {
        // Custody callback exception isolation
      }
    }
  }

  public sendError(
    messageId: string,
    payload: OcppMessageErrorPayload,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Stale generation check
    if (gen.gen !== this.host.currentGeneration.gen) {
      // Stale generation: settle immediately with socket_closed + old generation's cause
      const settlement: Settlement = {
        outcome: "socket_closed",
        closeCause: gen.closeCause ?? "network",
      };
      onSettled?.(settlement);
      return;
    }

    // Socket-open gate: spec section 2.5 requires settlement when socket is not open
    if (!this.host.isConnected()) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause: this.host.currentGeneration.closeCause ?? "network",
      });
      return;
    }

    // OCPP 1.6J CALLERROR: [4, messageId, errorCode, errorDescription, errorDetails]
    const message = encodeCallError(
      messageId,
      payload.errorCode,
      payload.errorDescription,
      payload.errorDetails,
    );
    const accepted = this.host.controller.sendUpstream(message, onSettled);

    // If sendUpstream returns false (overflow/stopped), settle immediately with queue_overflow
    if (!accepted && onSettled) {
      const settlement: Settlement = { outcome: "queue_overflow" };
      try {
        onSettled(settlement);
      } catch {
        // Custody callback exception isolation
      }
    }
  }

  /**
   * #393: an expert raw text frame, written as given. Shares the network-sim
   * pipeline, the `Sent:` log line and settlement with normal traffic; the
   * same generation and socket-open gates as `sendResult`.
   */
  public sendRaw(
    raw: string,
    gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    if (
      gen.gen !== this.host.currentGeneration.gen ||
      !this.host.isConnected()
    ) {
      onSettled?.({
        outcome: "socket_closed",
        closeCause:
          (gen.gen !== this.host.currentGeneration.gen
            ? gen.closeCause
            : this.host.currentGeneration.closeCause) ?? "network",
      });
      return;
    }
    const accepted = this.host.controller.sendUpstream(raw, onSettled);
    if (!accepted && onSettled) {
      try {
        onSettled({ outcome: "queue_overflow" });
      } catch {
        // Custody callback exception isolation
      }
    }
  }
}
