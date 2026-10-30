import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import { strictValidationErrors } from "../../../../ocpp/validate";
import { v201Schemas } from "../../../../ocpp/v201/schemas";
import { v21Schemas } from "../../../../ocpp/v21/schemas";

/**
 * #538, OCPP 2.0.1 / 2.1 N07.FR.04 / N08.FR.03 on the E11 queue (#528):
 * a queued NotifyEvent report is replayed after Boot Accepted, in the
 * order it was produced among the queued TransactionEvents, in parts cut
 * at send time, without any offline marker (NotifyEventRequest has none).
 * A queued NotifyEvent never holds a live TransactionEvent back.
 */

type Settle = (s: { outcome: string }) => void;

class FakeSocket {
  calls: Array<{ action: string; payload: unknown }> = [];
  connected = true;
  /** CALLs `sendAction` refuses next (network-sim refusal, not_accepted). */
  refuseNext = 0;
  /** The next CALL of this action `sendAction` refuses, once. */
  refuseAction: string | null = null;
  setMessageHandler(): void {}
  onCloseTransaction(): void {}
  isConnected(): boolean {
    return this.connected;
  }
  currentGeneration(): { gen: number; closeCause: string | null } {
    return { gen: 1, closeCause: null };
  }
  sendAction(
    _messageId: string,
    action: string,
    payload: unknown,
    _gen: unknown,
    onSettled?: Settle,
  ): boolean {
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      return false;
    }
    if (this.refuseAction === action) {
      this.refuseAction = null;
      return false;
    }
    this.calls.push({ action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  actions(): string[] {
    return this.calls.map((c) => c.action);
  }
  notifyEvents(): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.action === "NotifyEvent")
      .map((c) => c.payload as Record<string, unknown>);
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const NOTIFY_EVENT_SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.notifyEventRequestV201,
  "OCPP-2.1": v21Schemas.notifyEventRequestV21,
};

function event(
  eventId: number,
  severity = 4,
  actualValue = "500",
): MonitoringEvent {
  return {
    eventId,
    timestamp: new Date("2026-10-30T12:00:00.000Z"),
    monitor: {
      id: 1,
      type: "UpperThreshold",
      severity,
      value: 400,
      transaction: false,
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
      valueKey: "HeartbeatInterval",
      origin: "CustomMonitor",
    },
    trigger: "Alerting",
    cleared: false,
    actualValue,
  };
}

function setup(ocppVersion: string, offlineQueuingSeverity = 5) {
  const socket = new FakeSocket();
  const tx = {
    cpTransactionId: "tx-538",
    cpNextSeqNo: 0,
    tagId: "TAG-538",
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
  } as unknown as Transaction;
  const connector = { id: 1, transaction: tx, markTransactionChanged() {} };
  const cp = {
    id: `CP-538-${ocppVersion}`,
    database: null,
    ocppVersion,
    connectors: new Map([[1, connector]]),
    getConnector: () => connector,
    notifyOutgoingCall: vi.fn(),
    signedMeterFor: () => null,
    configuration: {
      transactionMessageAttempts: () => 3,
      transactionMessageRetryInterval: () => 60,
      messageTimeout: () => 30,
      meterValuesSampledData: () => [],
      offlineQueuingSeverity: () => offlineQueuingSeverity,
    },
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
  );
  const start = () =>
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
  const update = () =>
    handler.sendTransactionUpdate(1, { triggerReason: "MeterValuePeriodic" });
  const close = () => {
    socket.connected = false;
    handler.onWebSocketClosed();
  };
  const reconnect = () => {
    socket.connected = true;
    handler.flushPendingQueue();
  };
  return { socket, handler, start, update, close, reconnect };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s offline NotifyEvent queue (#538, N07.FR.04)",
  (version) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(logger.warn).mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const expectValid = (payloads: Record<string, unknown>[]) => {
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(
          strictValidationErrors(NOTIFY_EVENT_SCHEMAS[version], payload),
        ).toEqual([]);
        expect(payload).not.toHaveProperty("offline");
      }
    };

    it("replays a queued report after Boot Accepted, schema-valid and without an offline marker", () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      handler.queueNotifyEvent([event(1), event(2, 3, "600")]);
      expect(socket.calls).toEqual([]);

      reconnect();

      const replayed = socket.notifyEvents();
      expectValid(replayed);
      expect(replayed).toEqual([
        expect.objectContaining({
          generatedAt: "2026-10-30T12:00:00.000Z",
          seqNo: 0,
          tbc: false,
        }),
      ]);
      const data = replayed[0].eventData as Record<string, unknown>[];
      expect(data.map((d) => [d.eventId, d.actualValue])).toEqual([
        [1, "500"],
        [2, "600"],
      ]);
      expect(data[0].severity).toBe(version === "OCPP-2.1" ? 4 : undefined);
    });

    it("replays NotifyEvents and TransactionEvents in the order they were produced", () => {
      const { socket, handler, start, update, close, reconnect } =
        setup(version);
      close();
      start();
      handler.queueNotifyEvent([event(1)]);
      update();
      reconnect();
      expect(socket.actions()).toEqual([
        "TransactionEvent",
        "NotifyEvent",
        "TransactionEvent",
      ]);
    });

    it("cuts a large report into parts at send time (N07.FR.07)", () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      handler.queueNotifyEvent(
        Array.from({ length: 150 }, (_, i) => event(i + 1)),
      );
      reconnect();
      const parts = socket.notifyEvents();
      expectValid(parts);
      expect(
        parts.map((p) => [p.seqNo, p.tbc, (p.eventData as unknown[]).length]),
      ).toEqual([
        [0, true, 100],
        [1, false, 50],
      ]);
    });

    it("does not hold a live TransactionEvent behind a queued NotifyEvent", () => {
      const { socket, handler, start, close, reconnect } = setup(version);
      close();
      handler.queueNotifyEvent([event(1)]);
      // The replay is refused: the NotifyEvent stays at the head.
      socket.refuseNext = 1;
      reconnect();
      expect(socket.calls).toEqual([]);

      start();
      expect(socket.actions()).toEqual(["TransactionEvent"]);
      expect(
        (socket.calls[0].payload as { offline?: boolean }).offline,
      ).toBeUndefined();

      // The next Boot Accepted replays the NotifyEvent kept at the head.
      reconnect();
      expect(socket.actions()).toEqual(["TransactionEvent", "NotifyEvent"]);
    });

    it("lets a live TransactionEvent through once the queued ones replayed, a refused NotifyEvent left at the head", () => {
      const { socket, handler, start, update, close, reconnect } =
        setup(version);
      close();
      start();
      handler.queueNotifyEvent([event(1)]);
      socket.refuseAction = "NotifyEvent";
      reconnect();
      expect(socket.actions()).toEqual(["TransactionEvent"]);

      update();
      expect(socket.actions()).toEqual([
        "TransactionEvent",
        "TransactionEvent",
      ]);
      expect(
        (socket.calls[1].payload as { offline?: boolean }).offline,
      ).toBeUndefined();
    });

    it("keeps the TransactionEvents queued behind a refused NotifyEvent in order", () => {
      const { socket, handler, start, update, close, reconnect } =
        setup(version);
      close();
      handler.queueNotifyEvent([event(1)]);
      start();
      socket.refuseAction = "NotifyEvent";
      reconnect();
      expect(socket.calls).toEqual([]);

      // FIFO, as behind a refused TransactionEvent: a new event joins them.
      update();
      expect(socket.calls).toEqual([]);
      reconnect();
      expect(socket.actions()).toEqual([
        "NotifyEvent",
        "TransactionEvent",
        "TransactionEvent",
      ]);
    });

    it("queues a NotifyEvent the socket is down for, per OfflineQueuingSeverity", () => {
      const { socket, handler, close, reconnect } = setup(version, 4);
      close();
      handler.sendNotifyEvent([event(1, 4), event(2, 5)]);
      reconnect();
      const replayed = socket.notifyEvents();
      expectValid(replayed);
      expect(
        (replayed[0].eventData as { eventId: number }[]).map((d) => d.eventId),
      ).toEqual([1]);
    });
  },
);
