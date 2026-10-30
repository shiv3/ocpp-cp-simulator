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
 * #529, OCPP 2.0.1 / 2.1 E13 (2.0.1 Table 120 / 2.1 E13 use case,
 * Description and Remark): a
 * TransactionEvent left without a CALLRESULT or CALLERROR within
 * `OCPPCommCtrlr.MessageTimeout[Default]` is a failed transmission, like a
 * CALLERROR (#490). The same E13.FR.02-04 rules then apply: resend after
 * `MessageAttemptInterval[TransactionEvent]` x transmissions so far, discard
 * after `MessageAttempts[TransactionEvent]` transmissions.
 *
 * Late answers: any CALLRESULT settles the message (the first one is
 * applied, the scheduled resend is cancelled, the other transmissions are
 * forgotten); an answer to a forgotten transmission, or a failure of a
 * transmission already counted as failed, changes nothing.
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
  /** Settlements of the next CALLs ("written" once empty); "held" keeps
   *  the settlement in `held` until the test confirms the write. */
  outcomes: string[] = [];
  held: Array<() => void> = [];
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
    const outcome = this.outcomes.shift() ?? "written";
    if (outcome === "held") {
      this.held.push(() => onSettled?.({ outcome: "written" }));
    } else {
      onSettled?.({ outcome });
    }
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
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** A verdict that ends the transaction once applied: counting the
 *  `stopTransaction` calls tells how many times an answer was applied. */
const INVALID = { idTokenInfo: { status: "Invalid" } };

const SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.transactionEventRequestV201,
  "OCPP-2.1": v21Schemas.transactionEventRequestV21,
};

function transaction(): Transaction {
  return {
    cpTransactionId: "tx-529",
    cpNextSeqNo: 0,
    tagId: "TAG-529",
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
  } as unknown as Transaction;
}

function setup(
  ocppVersion: string,
  config: { attempts?: number; interval?: number; timeout?: number } = {},
) {
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
      transactionMessageAttempts: vi.fn(() => config.attempts ?? 3),
      transactionMessageRetryInterval: vi.fn(() => config.interval ?? 60),
      messageTimeout: vi.fn(() => config.timeout ?? 30),
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
  return { socket, tx, cp, handler, rejected, discarded, start };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s TransactionEvent timeout (#529, E13)",
  (version) => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resends an unanswered TransactionEvent with the same seqNo", () => {
      const { socket, start, rejected } = setup(version);
      start();
      const [first] = socket.transactionEvents();

      vi.advanceTimersByTime(29_999);
      expect(rejected).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(rejected).toEqual([
        {
          connectorId: 1,
          transactionId: "tx-529",
          action: "TransactionEvent",
          eventType: "Started",
          reason: "timeout",
          attempt: 1,
        },
      ]);

      vi.advanceTimersByTime(59_999);
      expect(socket.transactionEvents()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      const [, second] = socket.transactionEvents();
      expect(second.messageId).not.toBe(first.messageId);
      expect(second.payload).toEqual(first.payload);
      expect((second.payload as TransactionEventRequestV201).seqNo).toBe(
        (first.payload as TransactionEventRequestV201).seqNo,
      );
      for (const call of [first, second]) {
        expect(strictValidationErrors(SCHEMAS[version], call.payload)).toEqual(
          [],
        );
      }
    });

    it("discards the message after MessageAttempts unanswered transmissions", () => {
      const { socket, start, rejected, discarded, cp, tx } = setup(version);
      start();
      // 30 s timeout, 60 s wait, 30 s timeout, 120 s wait, 30 s timeout.
      vi.advanceTimersByTime(30_000 + 60_000 + 30_000 + 120_000 + 29_999);
      expect(socket.transactionEvents()).toHaveLength(3);
      expect(discarded).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(rejected.map((r) => [r.reason, r.attempt])).toEqual([
        ["timeout", 1],
        ["timeout", 2],
        ["timeout", 3],
      ]);
      expect(discarded).toEqual([
        {
          connectorId: 1,
          transactionId: "tx-529",
          action: "TransactionEvent",
          eventType: "Started",
          reason: "timeout",
          attempts: 3,
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.transactionEvents()).toHaveLength(3);
      expect(cp.stopTransaction).not.toHaveBeenCalled();
      expect(tx.stopTime).toBeNull();
    });

    it("reads MessageTimeout for each transmission", () => {
      const { socket, start, rejected, cp } = setup(version, {
        timeout: 5,
        interval: 1,
      });
      start();
      vi.advanceTimersByTime(5_000);
      expect(rejected).toHaveLength(1);
      cp.configuration.messageTimeout.mockReturnValue(10);
      vi.advanceTimersByTime(1_000);
      expect(socket.transactionEvents()).toHaveLength(2);
      vi.advanceTimersByTime(9_999);
      expect(rejected).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(rejected).toHaveLength(2);
    });

    it("does not time out a TransactionEvent answered in time", () => {
      const { socket, start, rejected } = setup(version);
      start();
      socket.callResult(socket.transactionEvents()[0].messageId, {});
      vi.advanceTimersByTime(10 * 60_000);
      expect(rejected).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the timeout of a transmission answered with CALLERROR", () => {
      const { socket, start, rejected } = setup(version);
      start();
      socket.callError(socket.transactionEvents()[0].messageId);
      expect(rejected.map((r) => r.reason)).toEqual(["callError"]);
      expect(rejected[0].errorCode).toBe("InternalError");
      // Only the resend's wait is left: no timeout fires at 30 s.
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(rejected).toHaveLength(1);
      expect(socket.transactionEvents()).toHaveLength(2);
    });

    it("applies a late CALLRESULT and cancels the resend still waiting", () => {
      const { socket, start, rejected, discarded, cp } = setup(version);
      start();
      const [first] = socket.transactionEvents();
      vi.advanceTimersByTime(30_000);
      expect(rejected).toHaveLength(1);

      socket.callResult(first.messageId, INVALID);
      expect(cp.stopTransaction).toHaveBeenCalledTimes(1);
      expect(cp.notifyStartTransactionNotAccepted).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(socket.transactionEvents()).toHaveLength(1);
      expect(discarded).toEqual([]);
    });

    it.each([
      ["the earlier transmission answers first", [0, 1]],
      ["the resend answers first", [1, 0]],
    ])(
      "applies only the first CALLRESULT once the resend is out (%s)",
      (_label, order) => {
        const { socket, start, rejected, discarded, cp } = setup(version);
        start();
        vi.advanceTimersByTime(30_000 + 60_000);
        const calls = socket.transactionEvents();
        expect(calls).toHaveLength(2);

        socket.callResult(calls[order[0]].messageId, INVALID);
        socket.callResult(calls[order[1]].messageId, INVALID);

        expect(cp.stopTransaction).toHaveBeenCalledTimes(1);
        expect(cp.notifyStartTransactionNotAccepted).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(10 * 60_000);
        expect(socket.transactionEvents()).toHaveLength(2);
        expect(rejected).toHaveLength(1);
        expect(discarded).toEqual([]);
      },
    );

    it("ignores a CALLERROR on the resend once the earlier transmission was answered", () => {
      const { socket, start, rejected, cp } = setup(version);
      start();
      vi.advanceTimersByTime(30_000 + 60_000);
      const [first, second] = socket.transactionEvents();
      socket.callResult(first.messageId, {});
      socket.callError(second.messageId);
      vi.advanceTimersByTime(10 * 60_000);
      expect(rejected).toHaveLength(1);
      expect(socket.transactionEvents()).toHaveLength(2);
      expect(cp.stopTransaction).not.toHaveBeenCalled();
    });

    it("does not count a late CALLERROR for a transmission that already timed out", () => {
      const { socket, start, rejected } = setup(version);
      start();
      const [first] = socket.transactionEvents();
      vi.advanceTimersByTime(30_000);
      socket.callError(first.messageId);
      expect(rejected).toHaveLength(1);
      vi.advanceTimersByTime(60_000);
      expect(socket.transactionEvents()).toHaveLength(2);
      // The resend's own timeout is the only timer left.
      expect(vi.getTimerCount()).toBe(1);
    });

    it.each(["queue_overflow", "write_failed"])(
      "still applies a late CALLRESULT to a timed-out transmission when the resend is lost (%s)",
      (outcome) => {
        const { socket, start, cp } = setup(version);
        start();
        const [first] = socket.transactionEvents();
        vi.advanceTimersByTime(30_000);
        socket.outcomes.push(outcome);
        vi.advanceTimersByTime(60_000);
        expect(socket.transactionEvents()).toHaveLength(2);

        socket.callResult(first.messageId, INVALID);
        expect(cp.stopTransaction).toHaveBeenCalledTimes(1);
        expect(cp.notifyStartTransactionNotAccepted).toHaveBeenCalledTimes(1);
      },
    );

    it("does not keep a resend written after the message was settled", () => {
      const { socket, start, handler } = setup(version);
      start();
      const [first] = socket.transactionEvents();
      vi.advanceTimersByTime(30_000);
      socket.outcomes.push("held");
      vi.advanceTimersByTime(60_000);
      const [, second] = socket.transactionEvents();
      socket.callResult(first.messageId, {});

      socket.held.shift()!();
      const pending = (
        handler as unknown as { _pendingRequests: Map<string, unknown> }
      )._pendingRequests;
      expect(pending.has(second.messageId)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a CALLRESULT arriving after the message was discarded", () => {
      const { socket, start, discarded, cp } = setup(version, {
        attempts: 1,
      });
      start();
      const [first] = socket.transactionEvents();
      vi.advanceTimersByTime(30_000);
      expect(discarded).toHaveLength(1);
      socket.callResult(first.messageId, INVALID);
      expect(cp.stopTransaction).not.toHaveBeenCalled();
    });

    it("clears the timeouts when the WebSocket closes", () => {
      const { socket, start, handler, rejected } = setup(version);
      start();
      expect(vi.getTimerCount()).toBe(1);
      handler.onWebSocketClosed();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(rejected).toEqual([]);
      expect(socket.transactionEvents()).toHaveLength(1);
    });

    it("clears a resend's timeout and a timed-out transmission when the WebSocket closes", () => {
      const { socket, start, handler, rejected, cp } = setup(version);
      start();
      vi.advanceTimersByTime(30_000 + 60_000);
      const [first] = socket.transactionEvents();
      handler.onWebSocketClosed();
      expect(vi.getTimerCount()).toBe(0);
      // The earlier transmission is forgotten with the connection.
      socket.callResult(first.messageId, INVALID);
      vi.advanceTimersByTime(10 * 60_000);
      expect(rejected).toHaveLength(1);
      expect(socket.transactionEvents()).toHaveLength(2);
      expect(cp.stopTransaction).not.toHaveBeenCalled();
    });

    it("queues once a timed-out transmission whose resend waits when the WebSocket closes", () => {
      const { socket, start, handler, rejected, cp } = setup(version);
      start();
      // The first transmission timed out and stays pending; its resend
      // waits out MessageAttemptInterval.
      vi.advanceTimersByTime(30_000);
      expect(rejected).toHaveLength(1);
      const [first] = socket.transactionEvents();
      vi.mocked(logger.warn).mockClear();
      handler.onWebSocketClosed();
      expect(vi.getTimerCount()).toBe(0);
      const queued = vi
        .mocked(logger.warn)
        .mock.calls.filter(([text]) =>
          String(text).includes("queued while offline"),
        );
      expect(queued).toHaveLength(1);
      socket.callResult(first.messageId, INVALID);
      vi.advanceTimersByTime(10 * 60_000);
      expect(rejected).toHaveLength(1);
      expect(socket.transactionEvents()).toHaveLength(1);
      expect(cp.stopTransaction).not.toHaveBeenCalled();
    });
  },
);
