import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../domain/connector/Transaction";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import type { TransactionEventRequestV201 } from "../../../../ocpp";

/**
 * #490, OCPP 2.0.1 / 2.1 E13.FR.02-04: a CALLERROR answering a
 * TransactionEvent is a failure to process it. The station sends the same
 * message again, waiting `MessageAttemptInterval[TransactionEvent]` times the
 * number of preceding transmissions, up to `MessageAttempts[TransactionEvent]`
 * transmissions in all, then discards it. The transaction is never touched.
 */

type Handler = (
  type: OCPPMessageType,
  id: string,
  action: string,
  payload: unknown,
) => void;

class FakeSocket {
  calls: Array<{ messageId: string; action: string; payload: unknown }> = [];
  connected = true;
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
    onSettled?: (s: { outcome: string }) => void,
  ): boolean {
    this.calls.push({ messageId, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
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
  last() {
    return this.calls[this.calls.length - 1];
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    cpTransactionId: "tx-490",
    cpNextSeqNo: 0,
    tagId: "TAG-490",
    startTime: new Date("2026-10-29T10:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
    ...overrides,
  } as unknown as Transaction;
}

function setup(config: { attempts?: number; interval?: number } = {}) {
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
    connectors: new Map([[1, connector]]),
    getConnector: vi.fn(() => connector),
    notifyOutgoingCall: vi.fn(),
    notifyAuthorizeResult: vi.fn(),
    notifyTransactionMessageRejected: vi.fn(
      (e: ChargePointEvents["transactionMessageRejected"]) => rejected.push(e),
    ),
    notifyTransactionMessageDiscarded: vi.fn(
      (e: ChargePointEvents["transactionMessageDiscarded"]) =>
        discarded.push(e),
    ),
    stopTransaction: vi.fn(),
    configuration: {
      transactionMessageAttempts: vi.fn(() => config.attempts ?? 3),
      transactionMessageRetryInterval: vi.fn(() => config.interval ?? 60),
      meterValuesSampledData: vi.fn(() => []),
    },
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
  );
  return { socket, tx, connector, cp, handler, rejected, discarded };
}

describe("OCPP 2.x TransactionEvent CALLERROR retry (#490, E13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resends Started after interval x1, then x2, then discards it", () => {
    const { socket, tx, handler, rejected, discarded, cp } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    const first = socket.last();
    expect(first.action).toBe("TransactionEvent");
    const firstPayload = first.payload as TransactionEventRequestV201;
    expect(firstPayload.eventType).toBe("Started");

    socket.callError(first.messageId);
    expect(rejected).toEqual([
      {
        connectorId: 1,
        transactionId: "tx-490",
        eventType: "Started",
        errorCode: "InternalError",
        attempt: 1,
      },
    ]);
    vi.advanceTimersByTime(59_999);
    expect(socket.transactionEvents()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.transactionEvents()).toHaveLength(2);
    const second = socket.last();
    expect(second.messageId).not.toBe(first.messageId);
    expect(second.payload).toEqual(firstPayload);

    socket.callError(second.messageId, "FormationViolation");
    expect(rejected[1]).toMatchObject({
      attempt: 2,
      errorCode: "FormationViolation",
    });
    vi.advanceTimersByTime(119_999);
    expect(socket.transactionEvents()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socket.transactionEvents()).toHaveLength(3);
    const third = socket.last();
    expect(new Set([first, second, third].map((c) => c.messageId)).size).toBe(
      3,
    );
    expect(third.payload).toEqual(firstPayload);

    socket.callError(third.messageId);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "tx-490",
        eventType: "Started",
        errorCode: "InternalError",
        attempts: 3,
      },
    ]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.transactionEvents()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    // The transaction is left alone.
    expect(cp.stopTransaction).not.toHaveBeenCalled();
    expect(tx.stopTime).toBeNull();
  });

  it("stops retrying once a resend gets a CALLRESULT", () => {
    const { socket, tx, handler, rejected, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    vi.advanceTimersByTime(60_000);
    socket.callResult(socket.last().messageId, {});
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.transactionEvents()).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(discarded).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a TransactionEvent answered with a CALLRESULT", () => {
    const { socket, tx, handler, rejected } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callResult(socket.last().messageId, {});
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.transactionEvents()).toHaveLength(1);
    expect(rejected).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries Updated and Ended the same way", () => {
    const { socket, tx, handler, rejected, discarded } = setup({
      attempts: 2,
      interval: 5,
    });
    handler.sendTransactionUpdate(1, { triggerReason: "MeterValuePeriodic" });
    const updated = socket.last();
    expect((updated.payload as TransactionEventRequestV201).eventType).toBe(
      "Updated",
    );
    socket.callError(updated.messageId);
    vi.advanceTimersByTime(5_000);
    expect(socket.last().payload).toEqual(updated.payload);
    socket.callError(socket.last().messageId);

    tx.stopTime = new Date("2026-10-29T11:00:00.000Z");
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: tx,
      connectorId: 1,
    });
    const ended = socket.last();
    expect((ended.payload as TransactionEventRequestV201).eventType).toBe(
      "Ended",
    );
    socket.callError(ended.messageId);
    vi.advanceTimersByTime(5_000);
    expect(socket.last().payload).toEqual(ended.payload);
    expect(socket.last().messageId).not.toBe(ended.messageId);
    socket.callError(socket.last().messageId);

    expect(rejected.map((r) => [r.eventType, r.attempt])).toEqual([
      ["Updated", 1],
      ["Updated", 2],
      ["Ended", 1],
      ["Ended", 2],
    ]);
    expect(discarded.map((d) => [d.eventType, d.attempts])).toEqual([
      ["Updated", 2],
      ["Ended", 2],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hold back the next transaction message while a retry waits", () => {
    const { socket, tx, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    handler.sendTransactionUpdate(1, { triggerReason: "MeterValuePeriodic" });
    expect(
      socket
        .transactionEvents()
        .map((c) => (c.payload as TransactionEventRequestV201).eventType),
    ).toEqual(["Started", "Updated"]);
  });

  it("reads the settings at each CALLERROR", () => {
    const { socket, tx, handler, cp, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    cp.configuration.transactionMessageAttempts.mockReturnValue(1);
    socket.callError(socket.last().messageId);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats attempts below 1 as a single transmission and a negative interval as 0", () => {
    const { socket, tx, handler, cp, discarded } = setup({ attempts: 0 });
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    expect(discarded).toHaveLength(1);

    cp.configuration.transactionMessageAttempts.mockReturnValue(2);
    cp.configuration.transactionMessageRetryInterval.mockReturnValue(-5);
    handler.sendTransactionUpdate(1, { triggerReason: "MeterValuePeriodic" });
    socket.callError(socket.last().messageId);
    vi.advanceTimersByTime(0);
    expect(socket.transactionEvents()).toHaveLength(3);
  });

  it("cancels a pending retry when the WebSocket closes", () => {
    const { socket, tx, handler, rejected, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    expect(vi.getTimerCount()).toBe(1);
    handler.onWebSocketClosed();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.transactionEvents()).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(discarded).toEqual([]);
  });

  it("logs a warning naming the resend a WebSocket close cancels", () => {
    const { socket, tx, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    vi.mocked(logger.warn).mockClear();
    handler.onWebSocketClosed();
    const messages = vi.mocked(logger.warn).mock.calls.map((c) => c[0]);
    expect(messages).toEqual([
      expect.stringMatching(
        /TransactionEvent Started .*tx-490.*attempt 2 cancelled/,
      ),
    ]);
  });

  it("logs a warning naming the resend dropped while disconnected", () => {
    const { socket, tx, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    socket.connected = false;
    vi.mocked(logger.warn).mockClear();
    vi.advanceTimersByTime(60_000);
    const messages = vi.mocked(logger.warn).mock.calls.map((c) => c[0]);
    expect(messages).toContainEqual(
      expect.stringMatching(
        /TransactionEvent Started .*tx-490.*attempt 2 dropped/,
      ),
    );
  });

  it("forgets a retry the socket drops, and does not retry other CALLs", () => {
    const { socket, tx, handler, rejected } = setup();
    handler.sendHeartbeat();
    socket.callError(socket.last().messageId);
    expect(rejected).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    socket.callError(socket.last().messageId);
    socket.connected = false;
    vi.advanceTimersByTime(60_000);
    // Not connected: the resend is dropped, and nothing is left behind.
    expect(socket.transactionEvents()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
