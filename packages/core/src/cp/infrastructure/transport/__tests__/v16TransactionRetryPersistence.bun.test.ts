import { describe, expect, it, mock } from "bun:test";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../domain/connector/Transaction";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { SqliteConnectorRuntimeRepository } from "../../../domain/persistence/SqliteConnectorRuntimeRepository";
import { Connector } from "../../../domain/connector/Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { RemoteStopTransactionHandler } from "../handlers/call/RemoteStopTransactionHandler";
import type { HandlerContext } from "../handlers/MessageHandlerRegistry";
import { OCPPMessageType, OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * #527, OCPP 1.6 Part 2 §3.7.1 counts failures "for this message": a resend
 * salvaged to the offline queue keeps its count across a restart, in the
 * existing `pending_messages.attempts` column. Its replay still goes out for
 * a transaction restored after the restart, identified by `idTag` and
 * `timestamp`.
 */
class FakeSocket {
  written: Array<{ id: string; action: string }> = [];
  incoming: ((...args: unknown[]) => void) | null = null;
  setMessageHandler(handler: (...args: unknown[]) => void): void {
    this.incoming = handler;
  }
  isConnected(): boolean {
    return true;
  }
  currentGeneration(): { gen: number; closeCause: string | null } {
    return { gen: 1, closeCause: null };
  }
  sendAction(
    id: string,
    action: string,
    _payload: unknown,
    _gen: unknown,
    onSettled?: (s: { outcome: string }) => void,
  ): boolean {
    this.written.push({ id, action });
    onSettled?.({ outcome: "written" });
    return true;
  }
  callError(id: string): void {
    this.incoming?.(OCPPMessageType.CALLERROR, id, undefined, {
      errorCode: "InternalError",
      errorDescription: "boom",
      errorDetails: {},
    });
  }
  callResult(id: string, payload: unknown): void {
    this.incoming?.(OCPPMessageType.CALLRESULT, id, undefined, payload);
  }
  last() {
    return this.written[this.written.length - 1]!;
  }
}

function runningTransaction(): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-527",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  } as Transaction;
}

function station(
  db: BunSqliteDatabase,
  restored: Transaction | null,
  connectorId = 1,
) {
  const socket = new FakeSocket();
  const connector = {
    id: connectorId,
    status: OCPPStatus.Charging,
    transaction: restored,
    transactionId: undefined as number | undefined,
    markStartCallError: mock(() => {}),
  };
  const rejected: Array<ChargePointEvents["transactionMessageRejected"]> = [];
  const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> = [];
  const cp = {
    id: "CP-527",
    database: db,
    connectors: new Map([[connectorId, connector]]),
    getConnector: (id: number) => (id === connectorId ? connector : undefined),
    notifyOutgoingCall() {},
    recordAuthorizationResult() {},
    signedMeterFor: () => null,
    updateConnectorStatus() {},
    notifyTransactionMessageRejected: (
      e: ChargePointEvents["transactionMessageRejected"],
    ) => rejected.push(e),
    notifyTransactionMessageDiscarded: (
      e: ChargePointEvents["transactionMessageDiscarded"],
    ) => discarded.push(e),
    configuration: {
      transactionMessageAttempts: () => 3,
      transactionMessageRetryInterval: () => 3_600,
    },
  };
  const codec: ProtocolCodec = { outgoingWarning: () => null };
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const handler = new OCPPMessageHandler(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger as unknown as Logger,
    codec,
  );
  handler.setBootStatus({ status: "Accepted" });
  return { socket, connector, handler, rejected, discarded };
}

function startResendSalvaged(db: BunSqliteDatabase) {
  const before = station(db, runningTransaction());
  before.handler.sendTransactionEvent({
    phase: "started",
    transaction: before.connector.transaction!,
    connectorId: 1,
  });
  before.socket.callError(before.socket.last().id);
  before.handler.onWebSocketClosed();
  return before;
}

function attemptsStored(db: BunSqliteDatabase): number[] {
  return db
    .all<{
      attempts: number;
    }>("SELECT attempts FROM pending_messages WHERE cp_id = ? ORDER BY seq", [
      "CP-527",
    ])
    .map((row) => row.attempts);
}

/** A row with no `connector_id`, whatever stored it. */
function storedStart(
  db: BunSqliteDatabase,
  payload: Record<string, unknown>,
): void {
  db.run(
    "INSERT INTO pending_messages " +
      "(cp_id, message_id, action, connector_id, payload, attempts, created_at, seq) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "CP-527",
      "row-1",
      "StartTransaction",
      null,
      JSON.stringify({
        idTag: "TAG-527",
        meterStart: 0,
        timestamp: "2026-10-30T10:00:00.000Z",
        ...payload,
      }),
      0,
      "2026-10-30T10:00:00.000Z",
      1,
    ],
  );
}

const ACCEPTED = { transactionId: 527, idTagInfo: { status: "Accepted" } };

describe("OCPP 1.6 connector of a StartTransaction.req answer (#527)", () => {
  it("a CALLRESULT for a row without connector_id goes to the payload's connector", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      storedStart(db, { connectorId: 2 });
      const s = station(db, runningTransaction(), 2);
      s.handler.flushPendingQueue();
      s.socket.callResult(s.socket.last().id, ACCEPTED);
      expect(s.connector.transactionId).toBe(527);
    } finally {
      db.close();
    }
  });

  it("a CALLERROR for a row without connector_id goes to the payload's connector", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      storedStart(db, { connectorId: 2 });
      const s = station(db, runningTransaction(), 2);
      s.handler.flushPendingQueue();
      s.socket.callError(s.socket.last().id);
      expect(s.rejected).toMatchObject([{ connectorId: 2, attempt: 1 }]);
      expect(s.discarded).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("with no connector anywhere, a CALLRESULT and a CALLERROR both go to connector 1", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      storedStart(db, {});
      const result = station(db, runningTransaction());
      result.handler.flushPendingQueue();
      result.socket.callResult(result.socket.last().id, ACCEPTED);
      expect(result.connector.transactionId).toBe(527);

      storedStart(db, {});
      const error = station(db, runningTransaction());
      error.handler.flushPendingQueue();
      error.socket.callError(error.socket.last().id);
      expect(error.rejected).toMatchObject([{ connectorId: 1, attempt: 1 }]);
      expect(error.discarded).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("an expert StartTransaction on connector 0 with applyResponse leaves connector 1 alone", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const s = station(db, runningTransaction());
      const answer = s.handler.sendOcppCall({
        action: "StartTransaction",
        payload: {
          connectorId: 0,
          idTag: "TAG-527",
          meterStart: 0,
          timestamp: "2026-10-30T10:00:00.000Z",
        },
        applyResponse: true,
      });
      s.socket.callResult(s.socket.last().id, ACCEPTED);
      await answer;
      expect(s.connector.transactionId).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("OCPP 1.6 transaction message retries across a restart (#527)", () => {
  it("a salvaged resend keeps its count: the replay is its second transmission", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      startResendSalvaged(db);
      expect(attemptsStored(db)).toEqual([1]);

      const after = station(db, runningTransaction());
      after.handler.flushPendingQueue();
      expect(after.socket.last().action).toBe("StartTransaction");
      after.socket.callError(after.socket.last().id);

      expect(after.rejected.map((r) => r.attempt)).toEqual([2]);
      expect(after.discarded).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a replayed StartTransaction.req still gets its conf on the restored transaction", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      startResendSalvaged(db);

      const after = station(db, runningTransaction());
      after.handler.flushPendingQueue();
      after.socket.callResult(after.socket.last().id, {
        transactionId: 527,
        idTagInfo: { status: "Accepted" },
      });

      expect(after.connector.transactionId).toBe(527);
      expect(after.discarded).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a salvaged resend whose transaction did not survive the restart is discarded", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      startResendSalvaged(db);

      const after = station(db, null);
      after.handler.flushPendingQueue();

      expect(after.socket.written).toEqual([]);
      expect(after.discarded).toEqual([
        {
          connectorId: 1,
          transactionId: "0",
          action: "StartTransaction",
          reason: "callError",
          attempts: 1,
        },
      ]);
      expect(attemptsStored(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a StartTransaction.req never transmitted replays whatever runs now: it precedes its StopTransaction.req", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const before = station(db, runningTransaction());
      before.socket.sendAction = () => false;
      before.handler.sendTransactionEvent({
        phase: "started",
        transaction: before.connector.transaction!,
        connectorId: 1,
      });
      expect(attemptsStored(db)).toEqual([0]);

      const after = station(db, null);
      after.handler.flushPendingQueue();

      expect(after.socket.written.map((w) => w.action)).toEqual([
        "StartTransaction",
      ]);
      expect(after.discarded).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("OCPP 1.6 startCallError across a restart (#527)", () => {
  /** A real connector, saved and restored through `connector_runtime`, then
   *  asked to stop the transaction with the `0` id. */
  function remoteStopAfterRestart(startCallError: boolean) {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      const logger = new Logger(LogLevel.ERROR);
      const before = new Connector(1, logger);
      before.beginTransaction(runningTransaction());
      if (startCallError) before.markStartCallError();
      repo.save("CP-527", 1, {
        ...before.snapshotRuntime(),
        scenarioPosition: null,
      });

      const restored = new Connector(1, logger);
      restored.restoreRuntimeSnapshot(repo.load("CP-527", 1)!);

      const chargePoint = {
        connectors: new Map([[1, restored]]),
        // Stops short of the stop itself: this test is about the match.
        isScenarioStopHandled: () => true,
        notifyRemoteStopReceived() {},
      };
      return new RemoteStopTransactionHandler().handle({ transactionId: 0 }, {
        chargePoint,
      } as unknown as HandlerContext);
    } finally {
      db.close();
    }
  }

  it("a restored `0` the CSMS failed to process is not one a RemoteStopTransaction can name", () => {
    expect(remoteStopAfterRestart(true)).toEqual({ status: "Rejected" });
  });

  it("a restored `0` with no CALLERROR behind it still matches", () => {
    expect(remoteStopAfterRestart(false)).toEqual({ status: "Accepted" });
  });
});
