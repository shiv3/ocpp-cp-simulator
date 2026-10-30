import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../domain/connector/Transaction";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import { strictValidationErrors } from "../../../../ocpp/validate";
import { v201Schemas } from "../../../../ocpp/v201/schemas";
import { v21Schemas } from "../../../../ocpp/v21/schemas";
import type { TransactionEventRequestV201 } from "../../../../ocpp";

/**
 * #528, OCPP 2.0.1 / 2.1 E11 (Connection Loss During Transaction):
 * E11.FR.01 queues every TransactionEventRequest the station would have
 * sent while online; E11.FR.02 sends the queued ones with `offline = true`
 * once the connection is restored (here: after BootNotification Accepted,
 * which calls `flushPendingQueue`). E11.FR.07 sets Offline on every
 * message still in the queue when the station goes offline, so a written
 * but unanswered TransactionEvent and a pending E13 resend are queued too.
 */

type Handler = (
  type: OCPPMessageType,
  id: string,
  action: string,
  payload: unknown,
) => void;

type Settle = (s: { outcome: string }) => void;

class FakeSocket {
  calls: Array<{ messageId: string; action: string; payload: unknown }> = [];
  connected = true;
  /** When set, settlements are held until `dropHeld` (network-sim delay). */
  holding = false;
  held: Settle[] = [];
  private handler: Handler | null = null;
  setMessageHandler(handler: Handler): void {
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
    messageId: string,
    action: string,
    payload: unknown,
    _gen: unknown,
    onSettled?: Settle,
  ): boolean {
    if (this.holding) {
      if (onSettled) this.held.push(onSettled);
      return true;
    }
    this.calls.push({ messageId, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  /** The pipeline drains on close: every held frame settles socket_closed. */
  dropHeld(): void {
    const held = this.held;
    this.held = [];
    for (const settle of held) settle({ outcome: "socket_closed" });
  }
  callError(messageId: string, errorCode = "InternalError"): void {
    this.handler!(OCPPMessageType.CALLERROR, messageId, "", {
      errorCode,
      errorDescription: "boom",
      errorDetails: {},
    });
  }
  callResult(messageId: string, payload: unknown = {}): void {
    this.handler!(OCPPMessageType.CALLRESULT, messageId, "", payload);
  }
  transactionEvents() {
    return this.calls.filter((c) => c.action === "TransactionEvent");
  }
  transactionPayloads(): TransactionEventRequestV201[] {
    return this.transactionEvents().map(
      (c) => c.payload as TransactionEventRequestV201,
    );
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.transactionEventRequestV201,
  "OCPP-2.1": v21Schemas.transactionEventRequestV21,
};

/** Lets pending microtasks run between steps. */
const settle = () => Promise.resolve();

function transaction(): Transaction {
  return {
    cpTransactionId: "tx-528",
    cpNextSeqNo: 0,
    tagId: "TAG-528",
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
  } as unknown as Transaction;
}

function setup(ocppVersion: string) {
  const socket = new FakeSocket();
  const tx = transaction();
  const connector = {
    id: 1,
    transaction: tx,
    markTransactionChanged: vi.fn(),
  };
  const rejected: Array<ChargePointEvents["transactionMessageRejected"]> = [];
  const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> = [];
  const cp = {
    id: `CP-528-${ocppVersion}`,
    database: null,
    ocppVersion,
    connectors: new Map([[1, connector]]),
    getConnector: vi.fn(() => connector),
    notifyOutgoingCall: vi.fn(),
    notifyAuthorizeResult: vi.fn(),
    notifyStartTransactionNotAccepted: vi.fn(),
    recordAuthorizationResult: vi.fn(),
    notifyTransactionMessageRejected: vi.fn(
      (e: ChargePointEvents["transactionMessageRejected"]) => rejected.push(e),
    ),
    notifyTransactionMessageDiscarded: vi.fn(
      (e: ChargePointEvents["transactionMessageDiscarded"]) =>
        discarded.push(e),
    ),
    stopTransaction: vi.fn(),
    signedMeterFor: vi.fn(() => null),
    configuration: {
      transactionMessageAttempts: vi.fn(() => 3),
      transactionMessageRetryInterval: vi.fn(() => 60),
      messageTimeout: vi.fn(() => 30),
      stopTransactionOnInvalidId: vi.fn(() => true),
      meterValuesSampledData: vi.fn(() => []),
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
  const end = () => {
    tx.stopTime = new Date("2026-10-30T11:00:00.000Z");
    (tx as { meterStop: number | null }).meterStop = 1234;
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: tx,
      connectorId: 1,
    });
  };
  /** The socket goes down: the close runs onWebSocketClosed. */
  const close = () => {
    socket.connected = false;
    socket.dropHeld();
    handler.onWebSocketClosed();
  };
  /** The socket comes back and BootNotification is Accepted. */
  const reconnect = () => {
    socket.connected = true;
    socket.holding = false;
    handler.flushPendingQueue();
  };
  return {
    socket,
    tx,
    cp,
    handler,
    rejected,
    discarded,
    start,
    update,
    end,
    close,
    reconnect,
  };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s offline TransactionEvent queue (#528, E11)",
  (version) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(logger.warn).mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const expectValid = (payloads: TransactionEventRequestV201[]) => {
      for (const payload of payloads) {
        expect(strictValidationErrors(SCHEMAS[version], payload)).toEqual([]);
      }
    };

    it("queues the events produced offline and replays them in order with offline=true", async () => {
      const { socket, start, update, end, close, reconnect } = setup(version);
      close();
      start();
      update();
      end();
      await settle();
      expect(socket.transactionEvents()).toEqual([]);

      reconnect();
      const replayed = socket.transactionPayloads();
      expect(replayed.map((p) => [p.eventType, p.seqNo, p.offline])).toEqual([
        ["Started", 0, true],
        ["Updated", 1, true],
        ["Ended", 2, true],
      ]);
      expectValid(replayed);
    });

    it("never sets offline on an event sent online", () => {
      const { socket, start } = setup(version);
      start();
      const [sent] = socket.transactionPayloads();
      expect(sent).not.toHaveProperty("offline");
    });

    it("queues a written but unanswered event when the socket closes", async () => {
      const { socket, start, close, reconnect, rejected } = setup(version);
      start();
      const [first] = socket.transactionEvents();
      close();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
      // A late answer to the transmission made before the close is ignored.
      socket.callResult(first.messageId, {
        idTokenInfo: { status: "Invalid" },
      });

      reconnect();
      const events = socket.transactionEvents();
      expect(events).toHaveLength(2);
      expect(events[1].messageId).not.toBe(first.messageId);
      expect(events[1].payload).toEqual({
        ...(first.payload as object),
        offline: true,
      });
      expect(rejected).toEqual([]);
      expectValid(socket.transactionPayloads());
    });

    it("queues a resend waiting out MessageAttemptInterval once", async () => {
      const { socket, start, close, reconnect } = setup(version);
      start();
      socket.callError(socket.transactionEvents()[0].messageId);
      close();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.transactionEvents()).toHaveLength(1);

      reconnect();
      const payloads = socket.transactionPayloads();
      expect(payloads.map((p) => [p.seqNo, p.offline])).toEqual([
        [0, undefined],
        [0, true],
      ]);
    });

    it("queues once a message whose timed-out transmission and resend are both unanswered", async () => {
      const { socket, start, close, reconnect } = setup(version);
      start();
      // Attempt 1 times out (30 s), attempt 2 goes out 60 s later.
      vi.advanceTimersByTime(30_000 + 60_000);
      expect(socket.transactionEvents()).toHaveLength(2);
      close();
      await settle();

      reconnect();
      expect(socket.transactionEvents()).toHaveLength(3);
      expect(socket.transactionPayloads()[2].offline).toBe(true);
    });

    it("keeps creation order when a newer event was still in the pipeline", async () => {
      const { socket, start, update, close, reconnect } = setup(version);
      start();
      socket.holding = true;
      update();
      close();
      await settle();

      reconnect();
      expect(
        socket.transactionPayloads().map((p) => [p.eventType, p.offline]),
      ).toEqual([
        ["Started", undefined],
        ["Started", true],
        ["Updated", true],
      ]);
    });

    // A network-sim cut drains the pipeline while the socket is still OPEN;
    // the close itself (and onWebSocketClosed) comes on a later task.
    it("keeps creation order when the pipeline drains before the socket closes", async () => {
      const { socket, start, update, handler, reconnect } = setup(version);
      start();
      socket.holding = true;
      update();
      socket.dropHeld();
      await settle();
      socket.connected = false;
      await settle();
      handler.onWebSocketClosed();

      reconnect();
      expect(
        socket.transactionPayloads().map((p) => [p.eventType, p.offline]),
      ).toEqual([
        ["Started", undefined],
        ["Started", true],
        ["Updated", true],
      ]);
    });

    it("keeps creation order for an event produced while the socket is closing", async () => {
      const { socket, start, update, handler, reconnect } = setup(version);
      start();
      // CLOSING: no longer connected, the close not processed yet.
      socket.connected = false;
      update();
      await settle();
      handler.onWebSocketClosed();

      reconnect();
      expect(
        socket.transactionPayloads().map((p) => [p.eventType, p.offline]),
      ).toEqual([
        ["Started", undefined],
        ["Started", true],
        ["Updated", true],
      ]);
    });

    it("queues an event produced while the queue still waits for its replay", async () => {
      const { socket, start, update, close, handler } = setup(version);
      close();
      start();
      await settle();
      // The socket is back but BootNotification is not Accepted yet.
      socket.connected = true;
      update();
      expect(socket.transactionEvents()).toEqual([]);

      handler.flushPendingQueue();
      expect(
        socket.transactionPayloads().map((p) => [p.eventType, p.seqNo]),
      ).toEqual([
        ["Started", 0],
        ["Updated", 1],
      ]);
    });

    it("applies E13 to a replayed event, with fresh attempt counters", async () => {
      const { socket, start, close, reconnect, rejected } = setup(version);
      start();
      socket.callError(socket.transactionEvents()[0].messageId);
      close();
      await settle();
      reconnect();
      const replay = socket.transactionEvents()[1];
      socket.callError(replay.messageId);
      expect(rejected.map((r) => r.attempt)).toEqual([1, 1]);
      vi.advanceTimersByTime(60_000);
      const resend = socket.transactionEvents()[2];
      expect(resend.messageId).not.toBe(replay.messageId);
      expect(resend.payload).toBe(replay.payload);
      expect((resend.payload as TransactionEventRequestV201).offline).toBe(
        true,
      );
    });

    it("settles a replayed event on its CALLRESULT", async () => {
      const { socket, start, close, reconnect, rejected } = setup(version);
      close();
      start();
      await settle();
      reconnect();
      socket.callResult(socket.transactionEvents()[0].messageId, {});
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.transactionEvents()).toHaveLength(1);
      expect(rejected).toEqual([]);
    });

    it("keeps the queue when the replay finds the socket closed", async () => {
      const { socket, start, close, handler, reconnect } = setup(version);
      close();
      start();
      await settle();
      handler.flushPendingQueue();
      expect(socket.transactionEvents()).toEqual([]);
      reconnect();
      expect(socket.transactionEvents()).toHaveLength(1);
    });

    it("requeues a replay the socket drops, in order", async () => {
      const { socket, start, update, close, handler, reconnect } =
        setup(version);
      close();
      start();
      update();
      await settle();
      // Boot Accepted, then the connection drops before the frames leave.
      socket.connected = true;
      socket.holding = true;
      handler.flushPendingQueue();
      close();
      await settle();
      reconnect();
      expect(
        socket.transactionPayloads().map((p) => [p.eventType, p.offline]),
      ).toEqual([
        ["Started", true],
        ["Updated", true],
      ]);
    });

    it("still drops other messages while offline", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      handler.sendHeartbeat();
      await settle();
      reconnect();
      expect(socket.calls).toEqual([]);
    });
  },
);
