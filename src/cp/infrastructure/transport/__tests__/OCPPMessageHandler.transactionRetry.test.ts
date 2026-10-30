import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageType, OCPPStatus } from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../domain/connector/Transaction";
import type { GenerationToken, Settlement } from "../network-sim";

/**
 * #527, OCPP 1.6 Part 2 §3.7.1: a CALLERROR answering a transaction-related
 * message is a failure to process it. The station sends the message again,
 * waiting `TransactionMessageRetryInterval` seconds times the number of
 * preceding transmissions, until `TransactionMessageAttempts` transmissions
 * failed, then discards it. The transaction keeps running. Driven by fake
 * timers; the end-to-end cases against a mock CSMS are in
 * v16TransactionMessageCallError.bun.test.ts.
 */
class FakeSocket {
  readonly written: Array<{ id: string; action: string; payload: unknown }> =
    [];
  incoming: ((...args: unknown[]) => void) | null = null;
  connected = true;
  private readonly gen: GenerationToken = { gen: 0, closeCause: null };

  setMessageHandler(handler: (...args: unknown[]) => void): void {
    this.incoming = handler;
  }
  currentGeneration(): GenerationToken {
    return this.gen;
  }
  isConnected(): boolean {
    return this.connected;
  }
  sendAction(
    id: string,
    action: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    if (!this.connected) return false;
    this.written.push({ id, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  last() {
    return this.written[this.written.length - 1]!;
  }
  callError(id: string, errorCode = "InternalError"): void {
    this.incoming?.(OCPPMessageType.CALLERROR, id, undefined, {
      errorCode,
      errorDescription: "boom",
      errorDetails: {},
    });
  }
  of(action: string) {
    return this.written.filter((w) => w.action === action);
  }
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-527",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterSent: false,
    ...overrides,
  } as Transaction;
}

function setup(config: { attempts?: number; interval?: number } = {}) {
  const socket = new FakeSocket();
  const connector = {
    id: 1,
    status: OCPPStatus.Preparing,
    transaction: transaction() as Transaction | null,
    markStartCallError() {
      if (this.transaction) this.transaction.startCallError = true;
    },
  };
  const rejected: Array<ChargePointEvents["transactionMessageRejected"]> = [];
  const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> = [];
  const chargePoint = {
    id: "CP-527",
    database: null,
    connectors: new Map([[1, connector]]),
    getConnector: vi.fn(() => connector),
    notifyOutgoingCall: vi.fn(),
    signedMeterFor: vi.fn(() => null),
    updateConnectorStatus: vi.fn((_id: number, status: OCPPStatus) => {
      connector.status = status;
    }),
    cleanTransaction: vi.fn(),
    notifyTransactionMessageRejected: vi.fn(
      (e: ChargePointEvents["transactionMessageRejected"]) => rejected.push(e),
    ),
    notifyTransactionMessageDiscarded: vi.fn(
      (e: ChargePointEvents["transactionMessageDiscarded"]) =>
        discarded.push(e),
    ),
    configuration: {
      transactionMessageAttempts: vi.fn(() => config.attempts ?? 3),
      transactionMessageRetryInterval: vi.fn(() => config.interval ?? 60),
    },
  };
  const codec: ProtocolCodec = { outgoingWarning: () => null };
  const handler = new OCPPMessageHandler(
    chargePoint as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    new Logger(LogLevel.ERROR),
    codec,
  );
  handler.setBootStatus({ status: "Accepted" });
  return { socket, connector, chargePoint, handler, rejected, discarded };
}

describe("OCPP 1.6 transaction message CALLERROR retry (#527, §3.7.1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resends StartTransaction after interval x1, then x2, then discards it", async () => {
    const { socket, connector, chargePoint, handler, rejected, discarded } =
      setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    expect(first.action).toBe("StartTransaction");

    socket.callError(first.id);
    expect(rejected).toEqual([
      {
        connectorId: 1,
        transactionId: "0",
        action: "StartTransaction",
        reason: "callError",
        errorCode: "InternalError",
        attempt: 1,
      },
    ]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(socket.of("StartTransaction")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const second = socket.last();
    expect(second.action).toBe("StartTransaction");
    expect(second.id).not.toBe(first.id);
    expect(second.payload).toEqual(first.payload);

    socket.callError(second.id);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(socket.of("StartTransaction")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = socket.last();
    expect(third.action).toBe("StartTransaction");

    socket.callError(third.id, "FormationViolation");
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "0",
        action: "StartTransaction",
        reason: "callError",
        errorCode: "FormationViolation",
        attempts: 3,
      },
    ]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(3);
    // The transaction keeps running, with its placeholder id: it was never
    // closed, and the station proceeds to Charging.
    expect(chargePoint.cleanTransaction).not.toHaveBeenCalled();
    expect(connector.transaction?.stopTime).toBeNull();
    expect(connector.transaction?.id).toBe(0);
    expect(chargePoint.updateConnectorStatus).toHaveBeenCalledTimes(1);
    expect(connector.status).toBe(OCPPStatus.Charging);
  });

  it("leaves the connector status alone while retrying, and after a discard out of Preparing", async () => {
    const { socket, connector, chargePoint, handler } = setup({
      attempts: 2,
      interval: 1,
    });
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chargePoint.updateConnectorStatus).not.toHaveBeenCalled();

    // A scenario's statusChange moved it on meanwhile: the discard does not
    // undo it.
    connector.status = OCPPStatus.SuspendedEV;
    socket.callError(socket.last().id);
    expect(chargePoint.updateConnectorStatus).not.toHaveBeenCalled();
    expect(connector.status).toBe(OCPPStatus.SuspendedEV);
  });

  it("resends StopTransaction with its transaction id and reports it", async () => {
    const { socket, handler, rejected, discarded } = setup({
      attempts: 2,
      interval: 10,
    });
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: transaction({
        id: 42,
        meterStop: 1_000,
        stopTime: new Date("2026-10-30T11:00:00.000Z"),
      }),
      connectorId: 1,
    });
    const first = socket.last();
    socket.callError(first.id);
    await vi.advanceTimersByTimeAsync(10_000);
    const second = socket.last();
    expect(second.action).toBe("StopTransaction");
    expect(second.payload).toEqual(first.payload);
    socket.callError(second.id);

    expect(rejected).toMatchObject([
      { action: "StopTransaction", transactionId: "42", attempt: 1 },
      { action: "StopTransaction", transactionId: "42", attempt: 2 },
    ]);
    expect(discarded).toMatchObject([
      { action: "StopTransaction", transactionId: "42", attempts: 2 },
    ]);
  });

  it("TransactionMessageAttempts 0 or 1: the first CALLERROR discards", () => {
    for (const attempts of [0, 1]) {
      const { socket, connector, handler, discarded } = setup({ attempts });
      handler.sendTransactionEvent({
        phase: "started",
        transaction: connector.transaction!,
        connectorId: 1,
      });
      socket.callError(socket.last().id);
      expect(discarded).toMatchObject([{ attempts: 1 }]);
      vi.runAllTimers();
      expect(socket.of("StartTransaction")).toHaveLength(1);
    }
  });

  it("a negative TransactionMessageRetryInterval resends at once", async () => {
    const { socket, connector, handler } = setup({ interval: -5 });
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.of("StartTransaction")).toHaveLength(2);
  });

  it("never resends an expert call", async () => {
    const { socket, handler, rejected } = setup();
    const answer = handler.sendOcppCall({
      action: "StartTransaction",
      payload: {
        connectorId: 1,
        idTag: "TAG-527",
        meterStart: 0,
        timestamp: "2026-10-30T10:00:00.000Z",
      },
      applyResponse: true,
    });
    socket.callError(socket.last().id);
    expect((await answer).kind).toBe("callError");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("on close, a waiting resend goes to the offline queue and is replayed once after the boot", async () => {
    const { socket, connector, handler, rejected } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    socket.callError(first.id);

    socket.connected = false;
    handler.onWebSocketClosed();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(1);

    socket.connected = true;
    handler.flushPendingQueue();
    const replayed = socket.last();
    expect(replayed.action).toBe("StartTransaction");
    expect(replayed.payload).toEqual(first.payload);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(2);

    // The replay is a fresh delivery: its CALLERROR count starts over.
    socket.callError(replayed.id);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 1]);
  });
});
