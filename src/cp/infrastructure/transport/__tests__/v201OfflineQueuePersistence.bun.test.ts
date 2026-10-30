import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
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
        // `offline` is set at replay time, never in what is stored.
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

    it("drops a queued row the 2.x handler does not replay", () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        db.run(
          "INSERT INTO pending_messages (cp_id, message_id, action, payload, created_at, seq) VALUES ('CP-528', 'm1', 'StartTransaction', '{}', ?, 1)",
          [new Date().toISOString()],
        );
        const logger = silentLogger();
        const { socket, handler } = station(db, version, logger);
        socket.connected = true;
        handler.flushPendingQueue();
        expect(socket.calls).toEqual([]);
        expect(rows(db)).toEqual([]);
        expect(logger.warn.mock.calls.map((c) => c[0])).toContainEqual(
          expect.stringMatching(/Dropping queued StartTransaction/),
        );
      } finally {
        db.close();
      }
    });
  },
);
