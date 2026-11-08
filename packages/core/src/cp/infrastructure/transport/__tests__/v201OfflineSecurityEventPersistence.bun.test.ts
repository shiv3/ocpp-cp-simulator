import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { strictValidationErrors } from "@ocpp-cp-sim/ocpp/validate";
import { v201Schemas } from "@ocpp-cp-sim/ocpp/v201/schemas";
import { v21Schemas } from "@ocpp-cp-sim/ocpp/v21/schemas";

/**
 * #552, A04.FR.02 with --state-db: a critical SecurityEventNotification
 * queued while offline is a `pending_messages` row, so a restart still
 * delivers it, with the time it happened, after the next Boot Accepted.
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
  "OCPP-2.0.1": v201Schemas.securityEventNotificationRequestV201,
  "OCPP-2.1": v21Schemas.securityEventNotificationRequestV21,
};

function station(db: BunSqliteDatabase, ocppVersion: string) {
  const socket = new FakeSocket();
  const cp = {
    id: "CP-552",
    database: db,
    ocppVersion,
    connectors: new Map(),
    getConnector: () => undefined,
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
  return { socket, handler };
}

function rows(db: BunSqliteDatabase) {
  return db.all<{ action: string }>(
    "SELECT action FROM pending_messages WHERE cp_id = ? ORDER BY seq",
    ["CP-552"],
  );
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s persisted offline SecurityEventNotification queue (#552)",
  (version) => {
    it("replays an event queued before a restart", async () => {
      const db = BunSqliteDatabase.open(":memory:");
      try {
        await station(db, version).handler.sendSecurityEventNotification(
          "SecurityLogWasCleared",
        );
        expect(rows(db).map((r) => r.action)).toEqual([
          "SecurityEventNotification",
        ]);

        const after = station(db, version);
        after.socket.connected = true;
        after.handler.flushPendingQueue();

        expect(after.socket.calls.map((c) => c.action)).toEqual([
          "SecurityEventNotification",
        ]);
        const payload = after.socket.calls[0].payload as { type: string };
        expect(strictValidationErrors(SCHEMAS[version], payload)).toEqual([]);
        expect(payload.type).toBe("SecurityLogWasCleared");
        expect(rows(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  },
);
