import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { strictValidationErrors } from "../../../../ocpp/validate";
import { v201Schemas } from "../../../../ocpp/v201/schemas";
import { v21Schemas } from "../../../../ocpp/v21/schemas";

/**
 * #538, N07.FR.04 with --state-db: a NotifyEvent queued while offline is a
 * `pending_messages` row, so a restart still delivers it after the next
 * Boot Accepted. A persisted NotifyEvent row alone does not hold a live
 * TransactionEvent back (only queued TransactionEvents do, #528).
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

const SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.notifyEventRequestV201,
  "OCPP-2.1": v21Schemas.notifyEventRequestV21,
};

const EVENT: MonitoringEvent = {
  eventId: 7,
  timestamp: new Date("2026-10-30T12:00:00.000Z"),
  monitor: {
    id: 1,
    type: "UpperThreshold",
    severity: 2,
    value: 400,
    transaction: false,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    origin: "CustomMonitor",
  },
  trigger: "Alerting",
  cleared: false,
  actualValue: "500",
};

function station(db: BunSqliteDatabase, ocppVersion: string) {
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
    id: "CP-538",
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
      offlineQueuingSeverity: () => 5,
    },
  };
  const logger = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger as unknown as Logger,
  );
  return { socket, tx, handler };
}

function rows(db: BunSqliteDatabase) {
  return db.all<{ action: string }>(
    "SELECT action FROM pending_messages WHERE cp_id = ? ORDER BY seq",
    ["CP-538"],
  );
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s persisted offline NotifyEvent queue (#538)",
  (version) => {
    it("replays a NotifyEvent queued before a restart", () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        station(db, version).handler.queueNotifyEvent([EVENT]);
        expect(rows(db).map((r) => r.action)).toEqual(["NotifyEvent"]);

        const after = station(db, version);
        after.socket.connected = true;
        after.handler.flushPendingQueue();

        expect(after.socket.calls.map((c) => c.action)).toEqual([
          "NotifyEvent",
        ]);
        const payload = after.socket.calls[0].payload as {
          eventData: { eventId: number }[];
        };
        expect(strictValidationErrors(SCHEMAS[version], payload)).toEqual([]);
        expect(payload.eventData.map((d) => d.eventId)).toEqual([7]);
        expect(rows(db)).toEqual([]);
      } finally {
        db.close();
      }
    });

    it("does not hold a live TransactionEvent behind a persisted NotifyEvent", () => {
      const db = BunSqliteDatabase.open(":memory:");
      let after: ReturnType<typeof station> | undefined;
      try {
        station(db, version).handler.queueNotifyEvent([EVENT]);

        // Restart: connected, Boot not yet Accepted, a transaction starts.
        after = station(db, version);
        after.socket.connected = true;
        after.handler.sendTransactionEvent({
          phase: "started",
          transaction: after.tx,
          connectorId: 1,
        });
        expect(after.socket.calls.map((c) => c.action)).toEqual([
          "TransactionEvent",
        ]);
        expect(rows(db).map((r) => r.action)).toEqual(["NotifyEvent"]);
      } finally {
        // Clear the MessageTimeout timer before the next file.
        after?.handler.onWebSocketClosed();
        db.close();
      }
    });
  },
);
