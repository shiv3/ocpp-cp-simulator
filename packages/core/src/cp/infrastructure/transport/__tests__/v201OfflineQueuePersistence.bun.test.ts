import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { strictValidationErrors } from "@ocpp-cp-simulator/ocpp/validate";
import { v201Schemas } from "@ocpp-cp-simulator/ocpp/v201/schemas";
import { v21Schemas } from "@ocpp-cp-simulator/ocpp/v21/schemas";
import type { TransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/index";

/**
 * #528, OCPP 2.0.1 / 2.1 E11: the TransactionEvents queued while offline
 * live in the `pending_messages` table when state persistence is on, so a
 * restart replays them (with `offline = true`, E11.FR.02) after the next
 * Boot Accepted — the 2.x twin of the 1.6 persisted queue.
 */

class FakeSocket {
  calls: Array<{ messageId: string; action: string; payload: unknown }> = [];
  handler: ((...args: unknown[]) => void) | null = null;
  connected = false;
  /** CALLs `sendAction` refuses next (network-sim refusal, not_accepted). */
  refuseNext = 0;
  setMessageHandler(handler: (...args: unknown[]) => void): void {
    this.handler = handler;
  }
  /** The CSMS answers the CALL `messageId` with an empty CALLRESULT. */
  answer(messageId: string): void {
    this.handler!(3, messageId, "", {});
  }
  /** A 2.x station sends the next CALL only after the answer (#708): answer
   *  every written CALL, one at a time, until no new one appears. */
  async answerAll(): Promise<void> {
    let answered = 0;
    while (answered < this.calls.length) {
      this.answer(this.calls[answered]!.messageId);
      answered += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      return false;
    }
    this.calls.push({ messageId, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
}

function silentLogger() {
  return {
    info: mock(() => {}),
    warn: mock((_message: string) => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

const SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.transactionEventRequestV201,
  "OCPP-2.1": v21Schemas.transactionEventRequestV21,
};

function station(
  db: BunSqliteDatabase,
  ocppVersion: string,
  logger = silentLogger(),
  maxEvents = 1000,
) {
  const socket = new FakeSocket();
  const tx = {
    cpTransactionId: "tx-528",
    cpNextSeqNo: 0,
    tagId: "TAG-528",
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
  } as unknown as Transaction;
  const connector = { id: 1, transaction: tx, markTransactionChanged() {} };
  const cp = {
    id: "CP-528",
    database: db,
    ocppVersion,
    connectors: new Map([[1, connector]]),
    getConnector: () => connector,
    notifyOutgoingCall() {},
    signedMeterFor: () => null,
    configuration: {
      transactionMessageAttempts: () => 3,
      transactionMessageRetryInterval: () => 60,
      messageTimeout: () => 30,
      offlineQueueMaxEvents: () => maxEvents,
      meterValuesSampledData: () => [],
    },
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger as unknown as Logger,
  );
  return { socket, tx, handler, logger };
}

function rows(db: BunSqliteDatabase) {
  return db.all<{ action: string; payload: string; connector_id: number }>(
    "SELECT action, payload, connector_id FROM pending_messages WHERE cp_id = ? ORDER BY seq",
    ["CP-528"],
  );
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s persisted offline TransactionEvent queue (#528)",
  (version) => {
    it("replays the events queued before a restart, in order, with offline=true", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      let after: ReturnType<typeof station> | undefined;
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        before.handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        await Promise.resolve();
        expect(before.socket.calls).toEqual([]);
        const stored = rows(db);
        expect(stored.map((r) => [r.action, r.connector_id])).toEqual([
          ["TransactionEvent", 1],
          ["TransactionEvent", 1],
        ]);
        // An event not yet replayed is stored without `offline`; the
        // replay sets it.
        for (const row of stored) {
          expect(JSON.parse(row.payload)).not.toHaveProperty("offline");
        }

        // Restart: a new handler over the same database, then Boot Accepted.
        after = station(db, version);
        after.socket.connected = true;
        after.handler.flushPendingQueue();
        // #708: one CALL in flight; the second waits for the answer.
        expect(after.socket.calls).toHaveLength(1);
        // #554: the rows stay until the CSMS answers.
        expect(rows(db)).toHaveLength(2);
        await after.socket.answerAll();
        const replayed = after.socket.calls.map(
          (c) => c.payload as TransactionEventRequestV201,
        );
        expect(replayed.map((p) => [p.eventType, p.seqNo, p.offline])).toEqual([
          ["Started", 0, true],
          ["Updated", 1, true],
        ]);
        for (const payload of replayed) {
          expect(strictValidationErrors(SCHEMAS[version], payload)).toEqual([]);
        }
        expect(rows(db)).toEqual([]);
      } finally {
        // Clear the replays' MessageTimeout timers before the next file.
        after?.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("holds a live event back behind the rows persisted before a restart", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      let after: ReturnType<typeof station> | undefined;
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        await Promise.resolve();

        // Restart: the socket is open, BootNotification not yet Accepted.
        after = station(db, version);
        after.socket.connected = true;
        after.tx.cpNextSeqNo = 1;
        after.handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        expect(after.socket.calls).toEqual([]);
        expect(rows(db)).toHaveLength(2);

        after.handler.flushPendingQueue();
        await after.socket.answerAll();
        const replayed = after.socket.calls.map(
          (c) => c.payload as TransactionEventRequestV201,
        );
        expect(replayed.map((p) => [p.eventType, p.seqNo])).toEqual([
          ["Started", 0],
          ["Updated", 1],
        ]);
      } finally {
        after?.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("keeps the row of a replay that waited for the slot and was refused only then (#554, #708)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      let after: ReturnType<typeof station> | undefined;
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        before.handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        await Promise.resolve();

        after = station(db, version);
        after.socket.connected = true;
        after.handler.flushPendingQueue();
        // Started holds the slot; Updated waits and is refused when its turn
        // comes (a full network-simulation queue).
        expect(after.socket.calls).toHaveLength(1);
        after.socket.refuseNext = 1;
        after.socket.answer(after.socket.calls[0].messageId);
        expect(after.socket.calls).toHaveLength(1);
        expect(
          rows(db).map(
            (row) =>
              (JSON.parse(row.payload) as { eventType: string }).eventType,
          ),
        ).toEqual(["Updated"]);
      } finally {
        after?.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("keeps a refused replay's row at the head of the persisted queue", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        before.handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        await Promise.resolve();
        const stored = rows(db);

        const after = station(db, version);
        after.socket.connected = true;
        after.socket.refuseNext = 1;
        after.handler.flushPendingQueue();
        expect(after.socket.calls).toEqual([]);
        // Same rows, same order: a reload still replays Started first.
        expect(rows(db)).toEqual(stored);
      } finally {
        db.close();
      }
    });

    it("keeps a replayed row until the CSMS answers, so a crash replays it again (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      const stations: Array<ReturnType<typeof station>> = [];
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        await Promise.resolve();

        // First run: replayed, written, never answered (a crash follows).
        const first = station(db, version);
        stations.push(first);
        first.socket.connected = true;
        first.handler.flushPendingQueue();
        expect(first.socket.calls).toHaveLength(1);
        expect(rows(db)).toHaveLength(1);

        // Second run replays it again, offline=true, and the answer clears it.
        const second = station(db, version);
        stations.push(second);
        second.socket.connected = true;
        second.handler.flushPendingQueue();
        expect(second.socket.calls).toHaveLength(1);
        expect(
          (second.socket.calls[0].payload as TransactionEventRequestV201)
            .offline,
        ).toBe(true);
        expect(rows(db)).toHaveLength(1);
        second.socket.answer(second.socket.calls[0].messageId);
        expect(rows(db)).toEqual([]);
      } finally {
        for (const s of stations) s.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("does not queue a replay twice when the socket closes before the answer (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      let run: ReturnType<typeof station> | undefined;
      try {
        const before = station(db, version);
        before.handler.sendTransactionEvent({
          phase: "started",
          transaction: before.tx,
          connectorId: 1,
        });
        await Promise.resolve();

        run = station(db, version);
        run.socket.connected = true;
        run.handler.flushPendingQueue();
        run.socket.connected = false;
        run.handler.onWebSocketClosed();
        expect(rows(db)).toHaveLength(1);

        // Back online: the same row replays, then the answer clears it.
        run.socket.connected = true;
        run.handler.flushPendingQueue();
        expect(run.socket.calls).toHaveLength(2);
        run.socket.answer(run.socket.calls[1].messageId);
        expect(rows(db)).toEqual([]);
      } finally {
        run?.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("answers E14 messagesInQueue from the queue, per transaction and overall (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { socket, tx, handler } = station(db, version);
        expect(handler.hasTransactionEventsToDeliver()).toBe(false);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        await Promise.resolve();
        expect(handler.hasTransactionEventsToDeliver()).toBe(true);
        expect(handler.hasTransactionEventsToDeliver("tx-528")).toBe(true);
        expect(handler.hasTransactionEventsToDeliver("other")).toBe(false);

        // Replayed but unanswered: still to be delivered.
        socket.connected = true;
        handler.flushPendingQueue();
        expect(handler.hasTransactionEventsToDeliver("tx-528")).toBe(true);
        socket.answer(socket.calls[0].messageId);
        expect(handler.hasTransactionEventsToDeliver()).toBe(false);
      } finally {
        db.close();
      }
    });

    it("drops Updated events from a full queue, never Started or Ended (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      let run: ReturnType<typeof station> | undefined;
      try {
        const logger = silentLogger();
        run = station(db, version, logger, 3);
        const { tx, handler, socket } = run;
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        handler.sendTransactionUpdate(1, { triggerReason: "Authorized" });
        handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        // Full (3). The next Updated pushes out the 2nd Updated (E11.FR.05).
        handler.sendTransactionUpdate(1, { triggerReason: "MeterValueClock" });
        await Promise.resolve();
        const queued = rows(db).map((r) => JSON.parse(r.payload));
        expect(
          queued.map((p) => [p.eventType, p.triggerReason, p.seqNo]),
        ).toEqual([
          ["Started", "Authorized", 0],
          ["Updated", "Authorized", 1],
          ["Updated", "MeterValueClock", 3],
        ]);
        // An Ended replaces the next Updated; Started and Ended stay.
        handler.sendTransactionEvent({
          phase: "ended",
          transaction: tx,
          connectorId: 1,
        });
        await Promise.resolve();
        const kinds = rows(db).map((r) => JSON.parse(r.payload).eventType);
        expect(kinds).toContain("Started");
        expect(kinds).toContain("Ended");
        expect(kinds.filter((k) => k === "Updated")).toHaveLength(1);

        socket.connected = true;
        handler.flushPendingQueue();
        const dropWarnings = logger.warn.mock.calls
          .map((c) => c[0])
          .filter((m) => /Dropped \d+ Updated TransactionEvent/.test(m));
        expect(dropWarnings).toHaveLength(1);
      } finally {
        run?.handler.onWebSocketClosed();
        db.close();
      }
    });

    it("thins the Updated events from the middle, keeping the first and the last (E11.FR.05, #554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { tx, handler } = station(db, version, silentLogger(), 4);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        for (let i = 0; i < 6; i++) {
          handler.sendTransactionUpdate(1, {
            triggerReason: "MeterValuePeriodic",
          });
        }
        await Promise.resolve();
        // Samples 1..6 arrive; the 2nd, then the 4th, then the 3rd of the
        // remaining ones go. Neither the oldest nor only the newest are kept.
        expect(rows(db).map((r) => JSON.parse(r.payload).seqNo)).toEqual([
          0, 1, 5, 6,
        ]);
      } finally {
        db.close();
      }
    });

    it("queues a new meter-value Updated and drops the lone Authorized Updated (E11.FR.05, #554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { tx, handler } = station(db, version, silentLogger(), 2);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        handler.sendTransactionUpdate(1, { triggerReason: "Authorized" });
        handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        await Promise.resolve();
        expect(
          rows(db).map((r) => JSON.parse(r.payload).triggerReason),
        ).toEqual(["Authorized", "MeterValuePeriodic"]);
        expect(rows(db).map((r) => JSON.parse(r.payload).eventType)).toEqual([
          "Started",
          "Updated",
        ]);
      } finally {
        db.close();
      }
    });

    it("queues Ended past the limit of 1 behind Started (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { tx, handler } = station(db, version, silentLogger(), 1);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        handler.sendTransactionEvent({
          phase: "ended",
          transaction: tx,
          connectorId: 1,
        });
        await Promise.resolve();
        expect(rows(db).map((r) => JSON.parse(r.payload).eventType)).toEqual([
          "Started",
          "Ended",
        ]);
      } finally {
        db.close();
      }
    });

    it("drops a new Updated event when the full queue holds nothing droppable (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { tx, handler } = station(db, version, silentLogger(), 1);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        handler.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
        });
        await Promise.resolve();
        expect(rows(db).map((r) => JSON.parse(r.payload).eventType)).toEqual([
          "Started",
        ]);
      } finally {
        db.close();
      }
    });

    it("applies no limit when OfflineQueueMaxEvents is 0 (#554)", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        const { tx, handler } = station(db, version, silentLogger(), 0);
        handler.sendTransactionEvent({
          phase: "started",
          transaction: tx,
          connectorId: 1,
        });
        for (let i = 0; i < 5; i++) {
          handler.sendTransactionUpdate(1, {
            triggerReason: "MeterValuePeriodic",
          });
        }
        await Promise.resolve();
        expect(rows(db)).toHaveLength(6);
      } finally {
        db.close();
      }
    });

    it("drops on load a queued row the 2.x handler does not replay", () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        db.run(
          "INSERT INTO pending_messages (cp_id, message_id, action, payload, created_at, seq) VALUES ('CP-528', 'm1', 'StartTransaction', '{}', ?, 1)",
          [new Date().toISOString()],
        );
        const logger = silentLogger();
        const { socket, handler } = station(db, version, logger);
        expect(rows(db)).toEqual([]);
        expect(logger.warn.mock.calls.map((c) => c[0])).toEqual([
          expect.stringMatching(
            /Dropped 1 queued message\(s\) not replayed on OCPP 2\.x: StartTransaction$/,
          ),
        ]);
        socket.connected = true;
        handler.flushPendingQueue();
        expect(socket.calls).toEqual([]);
      } finally {
        db.close();
      }
    });
  },
);

describe("OCPP 1.6 replay of a persisted 2.x row (#528)", () => {
  it("drops a TransactionEvent row on load with a warning and replays its own rows", () => {
    // `cp.update` can switch ocppVersion over the same --state-db: the 1.6
    // handler then finds the rows the 2.x handler queued.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const at = new Date().toISOString();
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, payload, created_at, seq) VALUES ('CP-528', 'm1', 'TransactionEvent', '{}', ?, 1)",
        [at],
      );
      db.run(
        "INSERT INTO pending_messages (cp_id, message_id, action, payload, created_at, seq) VALUES ('CP-528', 'm2', 'MeterValues', '{\"connectorId\":1,\"meterValue\":[]}', ?, 2)",
        [at],
      );
      const calls: string[] = [];
      const socket = {
        setMessageHandler() {},
        onCloseTransaction() {},
        isConnected: () => true,
        currentGeneration: () => ({ gen: 1, closeCause: null }),
        sendAction: (_id: string, action: string) => {
          calls.push(action);
          return true;
        },
      };
      const cp = {
        id: "CP-528",
        database: db,
        notifyOutgoingCall() {},
        configuration: {
          transactionMessageAttempts: () => 3,
          meterValuesSampledData: () => [],
        },
      };
      const logger = silentLogger();
      const handler = new OCPPMessageHandler(
        cp as unknown as ChargePoint,
        socket as unknown as OCPPWebSocket,
        logger as unknown as Logger,
        { outgoingWarning: () => null } as unknown as ProtocolCodec,
      );
      expect(rows(db).map((r) => r.action)).toEqual(["MeterValues"]);
      expect(logger.warn.mock.calls.map((c) => c[0])).toEqual([
        expect.stringMatching(
          /Dropped 1 queued message\(s\) not replayed on OCPP 1\.6: TransactionEvent$/,
        ),
      ]);
      handler.setBootStatus({ status: "Accepted" });
      handler.flushPendingQueue();
      expect(calls).toEqual(["MeterValues"]);
      expect(rows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
