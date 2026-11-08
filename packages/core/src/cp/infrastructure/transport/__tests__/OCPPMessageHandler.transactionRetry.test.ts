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
  callResult(id: string, payload: unknown): void {
    this.incoming?.(OCPPMessageType.CALLRESULT, id, undefined, payload);
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
    transactionId: undefined as number | undefined,
    assignTransactionId(id: number) {
      this.transactionId = id;
    },
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
    recordAuthorizationResult: vi.fn(),
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

  it("on close, a waiting resend goes to the offline queue and is replayed once after the boot, keeping its count", async () => {
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
    // Short of the 30 s watchdog: the CALLERROR below must count.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(socket.of("StartTransaction")).toHaveLength(2);

    // §3.7.1 counts failures for this message: the replay is transmission 2.
    socket.callError(replayed.id);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("a link that keeps dropping does not extend the count: discarded after TransactionMessageAttempts transmissions", async () => {
    const { socket, connector, handler, rejected, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    for (let dropped = 0; dropped < 2; dropped++) {
      socket.callError(socket.last().id);
      socket.connected = false;
      handler.onWebSocketClosed();
      socket.connected = true;
      handler.flushPendingQueue();
    }
    socket.callError(socket.last().id);

    expect(rejected.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(discarded).toMatchObject([{ attempts: 3 }]);
    socket.connected = false;
    handler.onWebSocketClosed();
    socket.connected = true;
    handler.flushPendingQueue();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(3);
  });

  it("a replay answered CALLERROR waits as transmission 2 does, then is resent", async () => {
    const { socket, connector, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    socket.connected = true;
    handler.flushPendingQueue();

    socket.callError(socket.last().id);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(socket.of("StartTransaction")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.of("StartTransaction")).toHaveLength(3);
  });

  it("a message salvaged before its first transmission starts at 1", async () => {
    const { socket, connector, handler, rejected } = setup();
    socket.connected = false;
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.connected = true;
    handler.flushPendingQueue();

    socket.callError(socket.last().id);

    expect(rejected.map((r) => r.attempt)).toEqual([1]);
  });

  it("a StopTransaction.req resend keeps its count across a close too", async () => {
    const { socket, handler, rejected, discarded } = setup({ attempts: 2 });
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: transaction({
        id: 42,
        meterStop: 1_000,
        stopTime: new Date("2026-10-30T11:00:00.000Z"),
      }),
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    socket.connected = true;
    handler.flushPendingQueue();

    socket.callError(socket.last().id);

    expect(rejected.map((r) => r.attempt)).toEqual([1, 2]);
    expect(discarded).toMatchObject([
      { action: "StopTransaction", attempts: 2 },
    ]);
  });

  it("a salvaged resend whose transaction stops offline is discarded at the replay; its StopTransaction.req goes out", async () => {
    const { socket, connector, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    const stopped = transaction({
      meterStop: 1_000,
      stopTime: new Date("2026-10-30T11:00:00.000Z"),
    });
    connector.transaction = stopped;
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: stopped,
      connectorId: 1,
    });

    socket.connected = true;
    handler.flushPendingQueue();

    expect(socket.of("StartTransaction")).toHaveLength(1);
    expect(socket.of("StopTransaction")).toHaveLength(1);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "0",
        action: "StartTransaction",
        reason: "callError",
        attempts: 1,
      },
    ]);
  });

  describe("a StartTransaction resend whose transaction no longer runs", () => {
    const discardNotice = {
      connectorId: 1,
      transactionId: "0",
      action: "StartTransaction",
      reason: "callError",
      errorCode: "InternalError",
      attempts: 1,
    };

    function retrying() {
      const station = setup();
      station.handler.sendTransactionEvent({
        phase: "started",
        transaction: station.connector.transaction!,
        connectorId: 1,
      });
      station.socket.callError(station.socket.last().id);
      return station;
    }

    // A local stop leaves a closed transaction on the connector until
    // cleanup; another stop path leaves none; a new one can begin since.
    const outlived: Array<[string, () => Transaction | null]> = [
      [
        "stopped",
        () => transaction({ stopTime: new Date("2026-10-30T10:30:00.000Z") }),
      ],
      ["cleared from its connector", () => null],
      ["replaced by another", () => transaction({ tagId: "TAG-OTHER" })],
    ];

    it.each(outlived)(
      "is discarded when its retry interval ends: transaction %s",
      async (_name, after) => {
        const { socket, connector, rejected, discarded } = retrying();
        connector.transaction = after();

        await vi.advanceTimersByTimeAsync(600_000);

        expect(socket.of("StartTransaction")).toHaveLength(1);
        expect(rejected.map((r) => r.attempt)).toEqual([1]);
        expect(discarded).toEqual([discardNotice]);
      },
    );

    it("is discarded when it leaves the serial queue behind another CALL", async () => {
      const { socket, connector, handler, discarded } = retrying();
      await vi.advanceTimersByTimeAsync(59_000);
      // An unanswered Heartbeat.req holds the serial slot when the retry
      // timer fires: the resend waits in the serial queue, not on its timer.
      handler.sendHeartbeat();
      const heartbeat = socket.last();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(discarded).toEqual([]);
      connector.transaction = transaction({
        stopTime: new Date("2026-10-30T10:30:00.000Z"),
      });

      socket.callResult(heartbeat.id, { currentTime: "2026-10-30T10:31:00Z" });

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([discardNotice]);
    });

    it("lets the CALL queued behind it go out", async () => {
      const { socket, connector, handler } = retrying();
      await vi.advanceTimersByTimeAsync(59_000);
      handler.sendHeartbeat();
      const heartbeat = socket.last();
      await vi.advanceTimersByTimeAsync(1_000);
      connector.transaction = null;
      handler.sendHeartbeat();

      socket.callResult(heartbeat.id, { currentTime: "2026-10-30T10:31:00Z" });

      expect(socket.of("Heartbeat")).toHaveLength(2);
    });

    it("is not salvaged to the offline queue when the socket closes, waiting out its interval", async () => {
      const { socket, connector, handler, discarded } = retrying();
      connector.transaction = null;

      socket.connected = false;
      handler.onWebSocketClosed();
      socket.connected = true;
      handler.flushPendingQueue();

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([discardNotice]);
    });

    it("is not salvaged to the offline queue when the socket closes, waiting in the serial queue", async () => {
      const { socket, connector, handler, discarded } = retrying();
      await vi.advanceTimersByTimeAsync(59_000);
      handler.sendHeartbeat();
      await vi.advanceTimersByTimeAsync(1_000);
      connector.transaction = null;

      socket.connected = false;
      handler.onWebSocketClosed();
      socket.connected = true;
      handler.flushPendingQueue();

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([discardNotice]);
    });

    it("is not salvaged to the offline queue when it falls due behind a closed boot gate", async () => {
      const { socket, connector, handler, discarded } = retrying();
      handler.setBootStatus({ status: "Pending" });
      connector.transaction = null;
      await vi.advanceTimersByTimeAsync(600_000);

      handler.setBootStatus({ status: "Accepted" });
      handler.flushPendingQueue();

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([discardNotice]);
    });

    it("reports each failed transmission: a stop after two CALLERRORs counts two", async () => {
      const { socket, connector, discarded } = retrying();
      await vi.advanceTimersByTimeAsync(60_000);
      socket.callError(socket.last().id, "GenericError");
      connector.transaction = null;

      await vi.advanceTimersByTimeAsync(120_000);

      expect(socket.of("StartTransaction")).toHaveLength(2);
      expect(discarded).toEqual([
        { ...discardNotice, errorCode: "GenericError", attempts: 2 },
      ]);
    });

    it("goes out while its transaction still runs", async () => {
      const { socket, discarded } = retrying();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.of("StartTransaction")).toHaveLength(2);
      expect(discarded).toEqual([]);
    });

    it("leaves a first transmission queued before the stop alone: it precedes the StopTransaction.req", async () => {
      const { socket, connector, handler, discarded } = setup();
      handler.sendHeartbeat();
      const heartbeat = socket.last();
      handler.sendTransactionEvent({
        phase: "started",
        transaction: connector.transaction!,
        connectorId: 1,
      });
      connector.transaction = null;

      socket.callResult(heartbeat.id, { currentTime: "2026-10-30T10:31:00Z" });

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([]);
    });

    it("carries on a StopTransaction.req and a MeterValues.req resend", async () => {
      const { socket, connector, handler, discarded } = setup();
      handler.sendTransactionEvent({
        phase: "ended",
        transaction: transaction({
          id: 42,
          meterStop: 1_000,
          stopTime: new Date("2026-10-30T11:00:00.000Z"),
        }),
        connectorId: 1,
      });
      socket.callError(socket.last().id);
      connector.transaction = null;

      await vi.advanceTimersByTimeAsync(60_000);

      expect(socket.of("StopTransaction")).toHaveLength(2);
      expect(discarded).toEqual([]);
    });
  });

  it("a CALLERROR after the CALL timed out changes nothing: 1.6 does not retry a timeout", async () => {
    const { socket, connector, handler, rejected, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    await vi.advanceTimersByTimeAsync(30_000);

    socket.callError(first.id);

    expect(rejected).toEqual([]);
    expect(discarded).toEqual([]);
    expect(connector.transaction?.startCallError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(1);
  });

  it("a resend's late CALLERROR ends its chain: the next attempt never goes out", async () => {
    const { socket, handler, rejected, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: transaction({
        id: 42,
        meterStop: 1_000,
        stopTime: new Date("2026-10-30T11:00:00.000Z"),
      }),
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(60_000);
    const resend = socket.last();
    expect(socket.of("StopTransaction")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);

    socket.callError(resend.id);

    expect(rejected.map((r) => r.attempt)).toEqual([1]);
    expect(discarded).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StopTransaction")).toHaveLength(2);
  });

  it("a CALLRESULT after the CALL timed out still applies to its transaction", async () => {
    const { socket, connector, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    await vi.advanceTimersByTimeAsync(30_000);

    socket.callResult(first.id, {
      transactionId: 527,
      idTagInfo: { status: "Accepted" },
    });

    expect(connector.transactionId).toBe(527);
  });

  it("a CALLRESULT after the CALL timed out leaves a transaction started since alone", async () => {
    const { socket, connector, handler } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    await vi.advanceTimersByTimeAsync(30_000);
    connector.transaction = transaction({ tagId: "TAG-OTHER" });

    socket.callResult(first.id, {
      transactionId: 527,
      idTagInfo: { status: "Accepted" },
    });

    expect(connector.transactionId).toBeUndefined();
  });

  it("a resend due while the boot gate is closed waits in the offline queue", async () => {
    const { socket, connector, handler, rejected } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    const first = socket.last();
    socket.callError(first.id);
    // A TriggerMessage BootNotification answered Pending closes the gate
    // while the link stays up.
    handler.setBootStatus({ status: "Pending" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.of("StartTransaction")).toHaveLength(1);

    handler.setBootStatus({ status: "Accepted" });
    handler.flushPendingQueue();
    const replayed = socket.last();
    expect(replayed.action).toBe("StartTransaction");
    expect(replayed.payload).toEqual(first.payload);
    socket.callError(replayed.id);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2]);
  });
});

describe("OCPP 1.6 replay of a message at a lowered TransactionMessageAttempts (#527, §3.7.1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Two transmissions of a StartTransaction.req failed, then the link drops:
   *  the offline queue holds the message with a count of 2. */
  async function startFailedTwiceThenClosed() {
    const station = setup();
    const { socket, connector, handler } = station;
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(60_000);
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    socket.connected = true;
    return station;
  }

  it("discards with a notice rather than sends a replay that already met the limit", async () => {
    const { socket, connector, chargePoint, handler, discarded } =
      await startFailedTwiceThenClosed();

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(2);
    handler.flushPendingQueue();

    expect(socket.of("StartTransaction")).toHaveLength(2);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "0",
        action: "StartTransaction",
        reason: "callError",
        attempts: 2,
      },
    ]);
    // As after a last attempt: the transaction goes on without a conf.
    expect(connector.status).toBe(OCPPStatus.Charging);

    handler.flushPendingQueue();
    expect(socket.of("StartTransaction")).toHaveLength(2);
    expect(discarded).toHaveLength(1);
  });

  it("gives one notice for a Start over the limit whose transaction stopped, and leaves the connector alone", async () => {
    const { socket, connector, chargePoint, handler, discarded } =
      await startFailedTwiceThenClosed();
    connector.transaction!.stopTime = new Date("2026-10-30T11:00:00.000Z");

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(2);
    handler.flushPendingQueue();

    expect(socket.of("StartTransaction")).toHaveLength(2);
    expect(discarded).toMatchObject([{ attempts: 2 }]);
    expect(chargePoint.updateConnectorStatus).not.toHaveBeenCalled();
  });

  it("still replays a message below the limit", async () => {
    const { socket, chargePoint, handler, discarded } =
      await startFailedTwiceThenClosed();

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(3);
    handler.flushPendingQueue();

    expect(socket.of("StartTransaction")).toHaveLength(3);
    expect(discarded).toEqual([]);
  });

  it("reports a StopTransaction with its id and goes on with the next message", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: transaction({
        id: 42,
        meterStop: 1_000,
        stopTime: new Date("2026-10-30T11:00:00.000Z"),
      }),
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.connected = true;

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(1);
    handler.flushPendingQueue();

    expect(socket.of("StopTransaction")).toHaveLength(1);
    expect(discarded).toMatchObject([
      { action: "StopTransaction", transactionId: "42", attempts: 1 },
    ]);
    expect(socket.of("StartTransaction")).toHaveLength(1);
  });

  it.each([0, 1])(
    "with the limit at %i, a message never transmitted still goes out",
    (limit) => {
      const { socket, connector, chargePoint, handler, discarded } = setup();
      socket.connected = false;
      handler.sendTransactionEvent({
        phase: "started",
        transaction: connector.transaction!,
        connectorId: 1,
      });
      expect(socket.of("StartTransaction")).toHaveLength(0);
      socket.connected = true;

      chargePoint.configuration.transactionMessageAttempts.mockReturnValue(
        limit,
      );
      handler.flushPendingQueue();

      expect(socket.of("StartTransaction")).toHaveLength(1);
      expect(discarded).toEqual([]);
    },
  );

  it("discards a resend waiting out its interval when the limit drops, with its last error", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id, "FormationViolation");

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.of("StartTransaction")).toHaveLength(1);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "0",
        action: "StartTransaction",
        reason: "callError",
        errorCode: "FormationViolation",
        attempts: 1,
      },
    ]);
    expect(connector.status).toBe(OCPPStatus.Charging);
  });

  it("discards a resend waiting in the serial queue when the limit drops", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(59_000);
    handler.sendHeartbeat();
    await vi.advanceTimersByTimeAsync(1_000);

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(1);
    socket.callResult(socket.last().id, {
      currentTime: "2026-10-30T10:00:00.000Z",
    });

    expect(socket.of("StartTransaction")).toHaveLength(1);
    expect(discarded).toMatchObject([
      { action: "StartTransaction", attempts: 1 },
    ]);
  });

  it("a CALL sent while the discard moves the connector leaves it once and keeps the queue in order", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(59_000);
    handler.sendHeartbeat();
    await vi.advanceTimersByTimeAsync(1_000);
    handler.sendHeartbeat();
    // As the StatusNotification a real status change sends.
    chargePoint.updateConnectorStatus.mockImplementation(
      (_id: number, status: OCPPStatus) => {
        connector.status = status;
        handler.sendHeartbeat();
      },
    );

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(1);
    socket.callResult(socket.last().id, {
      currentTime: "2026-10-30T10:00:00.000Z",
    });

    expect(discarded).toHaveLength(1);
    expect(socket.written.map((w) => w.action)).toEqual([
      "StartTransaction",
      "Heartbeat",
      "Heartbeat",
    ]);
    socket.callResult(socket.last().id, {
      currentTime: "2026-10-30T10:00:00.000Z",
    });
    expect(socket.of("Heartbeat")).toHaveLength(3);
  });

  it("still sends a resend below a limit that dropped", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup({
      attempts: 5,
    });
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(2);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.of("StartTransaction")).toHaveLength(2);
    expect(discarded).toEqual([]);
  });

  it("a limit of 0 counts as 1 for a message transmitted once", () => {
    const { socket, connector, chargePoint, handler, discarded } = setup();
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });
    socket.callError(socket.last().id);
    socket.connected = false;
    handler.onWebSocketClosed();
    socket.connected = true;

    chargePoint.configuration.transactionMessageAttempts.mockReturnValue(0);
    handler.flushPendingQueue();

    expect(socket.of("StartTransaction")).toHaveLength(1);
    expect(discarded).toMatchObject([{ attempts: 1 }]);
  });
});

describe("OCPP 1.6 transactionMessageRejected and the resend timer (#527)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a listener closing the link salvages the resend: no timer outlives the close", () => {
    const { socket, connector, chargePoint, handler } = setup();
    chargePoint.notifyTransactionMessageRejected.mockImplementation(() => {
      socket.connected = false;
      handler.onWebSocketClosed();
      return 1;
    });
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });

    socket.callError(socket.last().id);

    expect(vi.getTimerCount()).toBe(0);
    socket.connected = true;
    handler.flushPendingQueue();
    expect(socket.of("StartTransaction")).toHaveLength(2);
  });

  it("a listener still sees the notice before the resend, with no interval to wait", async () => {
    const { socket, connector, chargePoint, handler, discarded } = setup({
      interval: 0,
    });
    const writtenAtNotice: number[] = [];
    chargePoint.notifyTransactionMessageRejected.mockImplementation(() =>
      writtenAtNotice.push(socket.of("StartTransaction").length),
    );
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });

    socket.callError(socket.last().id);
    await vi.advanceTimersByTimeAsync(0);

    expect(writtenAtNotice).toEqual([1]);
    expect(socket.of("StartTransaction")).toHaveLength(2);
    expect(discarded).toEqual([]);
  });

  it("the last attempt still reports the rejection before the discard", () => {
    const { socket, connector, chargePoint, handler } = setup({ attempts: 1 });
    const order: string[] = [];
    chargePoint.notifyTransactionMessageRejected.mockImplementation(() =>
      order.push("rejected"),
    );
    chargePoint.notifyTransactionMessageDiscarded.mockImplementation(() =>
      order.push("discarded"),
    );
    handler.sendTransactionEvent({
      phase: "started",
      transaction: connector.transaction!,
      connectorId: 1,
    });

    socket.callError(socket.last().id);

    expect(order).toEqual(["rejected", "discarded"]);
  });
});

describe("OCPP 1.6 transactionMessageDiscarded listener changing the transaction (#527)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const replacements: Array<[string, () => Transaction | null]> = [
    [
      "starts another one",
      () => transaction({ startTime: new Date("2026-10-30T10:05:00.000Z") }),
    ],
    ["stops it", () => null],
  ];

  it.each(replacements)(
    "after a last attempt: a listener that %s keeps the connector out of Charging",
    (_name, replacement) => {
      const { socket, connector, chargePoint, handler, discarded } = setup({
        attempts: 1,
      });
      chargePoint.notifyTransactionMessageDiscarded.mockImplementation(() => {
        connector.transaction = replacement();
        return discarded.length;
      });
      handler.sendTransactionEvent({
        phase: "started",
        transaction: connector.transaction!,
        connectorId: 1,
      });
      socket.callError(socket.last().id);

      expect(
        chargePoint.notifyTransactionMessageDiscarded,
      ).toHaveBeenCalledOnce();
      expect(chargePoint.updateConnectorStatus).not.toHaveBeenCalled();
      expect(connector.status).toBe(OCPPStatus.Preparing);
    },
  );

  it.each(replacements)(
    "at a lowered limit: a listener that %s keeps the connector out of Charging",
    async (_name, replacement) => {
      const { socket, connector, chargePoint, handler, discarded } = setup();
      chargePoint.notifyTransactionMessageDiscarded.mockImplementation(() => {
        connector.transaction = replacement();
        return discarded.length;
      });
      handler.sendTransactionEvent({
        phase: "started",
        transaction: connector.transaction!,
        connectorId: 1,
      });
      socket.callError(socket.last().id);
      chargePoint.configuration.transactionMessageAttempts.mockReturnValue(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(
        chargePoint.notifyTransactionMessageDiscarded,
      ).toHaveBeenCalledOnce();
      expect(chargePoint.updateConnectorStatus).not.toHaveBeenCalled();
      expect(connector.status).toBe(OCPPStatus.Preparing);
    },
  );
});
