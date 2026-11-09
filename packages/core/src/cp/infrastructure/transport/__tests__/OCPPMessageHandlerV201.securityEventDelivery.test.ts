import { describe, expect, it, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

/**
 * #664, A04.FR.02: a critical SecurityEventNotification reaches the CSMS. Since
 * the one-CALL-in-flight queue (#802) a replayed row used to leave the E11
 * table when it was handed to `send()`, so a close before the write, or before
 * the answer, lost it. The row now stays until the CSMS answers.
 */

type Settle = (s: { outcome: string }) => void;

class FakeSocket {
  calls: Array<{ id: string; action: string; payload: unknown }> = [];
  connected = true;
  /** The CSMS answers each written CALL after the write returns. */
  autoAnswer = false;
  private handler:
    | ((type: number, id: string, action: string, payload: unknown) => void)
    | null = null;
  setMessageHandler(
    handler: (
      type: number,
      id: string,
      action: string,
      payload: unknown,
    ) => void,
  ): void {
    this.handler = handler;
  }
  onCloseTransaction(): void {}
  isConnected(): boolean {
    return this.connected;
  }
  currentGeneration(): { gen: number; closeCause: string | null } {
    return { gen: 1, closeCause: null };
  }
  sendAction(
    id: string,
    action: string,
    payload: unknown,
    _gen: unknown,
    onSettled?: Settle,
  ): boolean {
    this.calls.push({ id, action, payload });
    onSettled?.({ outcome: "written" });
    if (this.autoAnswer) {
      queueMicrotask(() => this.handler?.(3, id, action, {}));
    }
    return true;
  }
  answer(id: string): void {
    this.handler?.(3, id, "SecurityEventNotification", {});
  }
  types(): string[] {
    return this.calls
      .filter((c) => c.action === "SecurityEventNotification")
      .map((c) => (c.payload as { type: string }).type);
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function setup(ocppVersion: string) {
  const socket = new FakeSocket();
  const cp = {
    id: `CP-664-${ocppVersion}`,
    ocppVersion,
    connectors: new Map(),
    getConnector: () => undefined,
    notifyOutgoingCall: vi.fn(),
    signedMeterFor: () => null,
    configuration: {
      transactionMessageAttempts: () => 3,
      transactionMessageRetryInterval: () => 60,
      messageTimeout: () => 30,
      meterValuesSampledData: () => [],
      offlineQueuingSeverity: () => 5,
      offlineQueueMaxEvents: () => 1000,
    },
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
  );
  const close = () => {
    socket.connected = false;
    handler.onWebSocketClosed();
  };
  const settle = async () => {
    for (let seen = -1; seen !== socket.calls.length;) {
      seen = socket.calls.length;
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
  };
  const reconnectAnswering = async () => {
    socket.connected = true;
    socket.autoAnswer = true;
    handler.flushPendingQueue();
    await settle();
  };
  return { socket, handler, close, reconnectAnswering };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s critical SecurityEventNotification delivery (#664)",
  (version) => {
    it("a replay written but unanswered when the link closes is sent again", async () => {
      const { socket, handler, close, reconnectAnswering } = setup(version);
      close();
      await handler.sendSecurityEventNotification("TamperDetectionActivated");
      await handler.sendSecurityEventNotification("MemoryExhaustion");

      socket.connected = true;
      handler.flushPendingQueue();
      // First event on the wire, unanswered; the second waits for the slot.
      expect(socket.types()).toEqual(["TamperDetectionActivated"]);

      close();
      await reconnectAnswering();

      expect(socket.types().slice(1)).toEqual([
        "TamperDetectionActivated",
        "MemoryExhaustion",
      ]);
    });

    it("a replay still waiting for the slot when the link closes is not lost", async () => {
      const { socket, handler, close, reconnectAnswering } = setup(version);
      close();
      await handler.sendSecurityEventNotification("TamperDetectionActivated");
      await handler.sendSecurityEventNotification("MemoryExhaustion");

      socket.connected = true;
      handler.flushPendingQueue();
      // Answer the first: the second is written and unanswered ...
      socket.answer(socket.calls[0]!.id);
      expect(socket.types()).toEqual([
        "TamperDetectionActivated",
        "MemoryExhaustion",
      ]);

      close();
      await reconnectAnswering();
      // ... and is sent again; the answered one is not.
      expect(socket.types().slice(2)).toEqual(["MemoryExhaustion"]);
    });

    it("an answered replay leaves the queue: nothing is sent twice", async () => {
      const { socket, handler, close, reconnectAnswering } = setup(version);
      close();
      await handler.sendSecurityEventNotification("TamperDetectionActivated");
      await reconnectAnswering();
      close();
      await reconnectAnswering();
      expect(socket.types()).toEqual(["TamperDetectionActivated"]);
    });

    it("a critical event written online but unanswered at a close is queued and replayed", async () => {
      const { socket, handler, close, reconnectAnswering } = setup(version);
      await handler.sendSecurityEventNotification("ResetOrReboot");
      expect(socket.types()).toEqual(["ResetOrReboot"]);

      close();
      await reconnectAnswering();
      expect(socket.types()).toEqual(["ResetOrReboot", "ResetOrReboot"]);
    });

    it("a critical event answered online is not queued by a later close", async () => {
      const { socket, handler, close, reconnectAnswering } = setup(version);
      await handler.sendSecurityEventNotification("ResetOrReboot");
      socket.answer(socket.calls[0]!.id);
      close();
      await reconnectAnswering();
      expect(socket.types()).toEqual(["ResetOrReboot"]);
    });
  },
);
