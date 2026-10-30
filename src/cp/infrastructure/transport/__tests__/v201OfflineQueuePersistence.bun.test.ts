import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { strictValidationErrors } from "../../../../ocpp/validate";
import { v201Schemas } from "../../../../ocpp/v201/schemas";
import { v21Schemas } from "../../../../ocpp/v21/schemas";
import type { TransactionEventRequestV201 } from "../../../../ocpp";

/**
 * #528, OCPP 2.0.1 / 2.1 E11: the TransactionEvents queued while offline
 * live in the `pending_messages` table when state persistence is on, so a
 * restart replays them (with `offline = true`, E11.FR.02) after the next
 * Boot Accepted — the 2.x twin of the 1.6 persisted queue.
 */

class FakeSocket {
  calls: Array<{ action: string; payload: unknown }> = [];
  connected = false;
  /** CALLs `sendAction` refuses next (network-sim refusal, not_accepted). */
  refuseNext = 0;
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
    onSettled?: (s: { outcome: string }) => void,
  ): boolean {
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      return false;
    }
    this.calls.push({ action, payload });
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
