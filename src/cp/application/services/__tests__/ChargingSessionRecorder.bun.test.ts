import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { InMemoryChargingSessionRepository } from "../../../domain/persistence/ChargingSessionRepository";
import type { ChargingSession } from "../../../domain/session/ChargingSession";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "../../../infrastructure/transport/__tests__/mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
} from "../../../infrastructure/transport/__tests__/stationHarness";
import { canBindBunServe } from "../../../../test/bunServe";
import { activeChargingSession } from "../../../../test/chargingSessionFixtures";
import { ChargingSessionRecorder } from "../ChargingSessionRecorder";

/**
 * #447 acceptance: one normal and one abnormal session for OCPP 1.6 and 2.x,
 * on a real charge point talking to the mock CSMS, land in the same
 * normalized shape.
 */

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const transactionEvent =
  (eventType: TransactionEventRequestV201["eventType"]) =>
  (frame: OcppFrame): boolean =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as TransactionEventRequestV201).eventType === eventType;

interface Station {
  cp: ChargePoint;
  csms: MockCsms;
  repo: InMemoryChargingSessionRepository;
  sessions: () => ChargingSession[];
  stop: () => Promise<void>;
}

async function station(
  id: string,
  version: string,
  skip: readonly string[],
): Promise<Station> {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, version);
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  const repo = new InMemoryChargingSessionRepository();
  const recorder = new ChargingSessionRecorder(cp, repo);
  const stopAnswering = answerEverythingElse(csms, skip);
  return {
    cp,
    csms,
    repo,
    sessions: () => repo.list({ cpId: id, order: "asc" }).sessions,
    stop: async () => {
      stopAnswering();
      recorder.dispose();
      cp.disconnect();
      await csms.stop();
    },
  };
}

describe.skipIf(!canBindBunServe())("ChargingSessionRecorder (#447)", () => {
  describe("OCPP 1.6", () => {
    it("records a normal session: CSMS id, energy, duration, Local stop", async () => {
      const s = await station("CP16-NORMAL", "OCPP-1.6J", ["StartTransaction"]);
      try {
        s.cp.getConnector(1)!.meterValue = 1000;
        void s.cp.startTransaction("TAG-16", 1);
        const start = await s.csms.waitForCall("StartTransaction");
        expect(s.sessions()).toMatchObject([
          { outcome: "active", transactionId: null, meterStartWh: 1000 },
        ]);
        s.csms.replyCallResult(start.messageId, {
          transactionId: 42,
          idTagInfo: { status: "Accepted" },
        });
        await until(
          () => s.sessions()[0]?.transactionId === "42",
          "the CSMS transaction id",
        );

        s.cp.getConnector(1)!.meterValue = 4500;
        s.cp.stopTransaction(1);
        await s.csms.waitForCall("StopTransaction");

        const [session] = s.sessions();
        expect(session).toMatchObject({
          cpId: "CP16-NORMAL",
          connectorId: 1,
          evseId: null,
          ocppVersion: "OCPP-1.6J",
          transactionId: "42",
          idTag: "TAG-16",
          meterStartWh: 1000,
          meterStopWh: 4500,
          energyWh: 3500,
          stopReason: "Local",
          triggerReason: null,
          authorizationStatus: null,
          outcome: "completed",
        });
        expect(session!.durationMs).toBe(
          Date.parse(session!.endedAt!) - Date.parse(session!.startedAt),
        );
      } finally {
        await s.stop();
      }
    });

    it("records a session stopped by a hard reset as interrupted", async () => {
      const s = await station("CP16-RESET", "OCPP-1.6J", []);
      try {
        void s.cp.startTransaction("TAG-16", 1);
        await s.csms.waitForCall("StartTransaction");
        s.cp.stopTransaction(1, "HardReset");
        await s.csms.waitForCall("StopTransaction");

        expect(s.sessions()).toMatchObject([
          { stopReason: "HardReset", outcome: "interrupted" },
        ]);
      } finally {
        await s.stop();
      }
    });

    it("records a StartTransaction CALLERROR as failed", async () => {
      const s = await station("CP16-ERROR", "OCPP-1.6J", ["StartTransaction"]);
      try {
        void s.cp.startTransaction("TAG-16", 1);
        const start = await s.csms.waitForCall("StartTransaction");
        s.csms.send([4, start.messageId, "InternalError", "boom", {}]);
        await until(() => s.sessions()[0]?.outcome === "failed", "failed");

        const [session] = s.sessions();
        expect(session).toMatchObject({
          transactionId: null,
          stopReason: null,
          energyWh: 0,
        });
        expect(session!.endedAt).not.toBeNull();
        expect(s.sessions()).toHaveLength(1);
      } finally {
        await s.stop();
      }
    });

    it("does not reopen a failed start that a later reset stops again", async () => {
      const s = await station("CP16-ERROR-RESET", "OCPP-1.6J", [
        "StartTransaction",
      ]);
      try {
        void s.cp.startTransaction("TAG-16", 1);
        const start = await s.csms.waitForCall("StartTransaction");
        s.csms.send([4, start.messageId, "InternalError", "boom", {}]);
        await until(() => s.sessions()[0]?.outcome === "failed", "failed");

        const [failed] = s.sessions();

        // #491: the failed transaction is detached, so a reset (and a direct
        // stop) finds nothing to stop and the failed session is left as is.
        s.cp.applyRemoteReset("Soft");
        s.cp.stopTransaction(1, "HardReset");

        expect(s.cp.getConnector(1)?.transaction).toBeNull();
        expect(s.sessions()).toEqual([failed]);
      } finally {
        await s.stop();
      }
    });

    it("records an id the CSMS rejected, and stopped on, as failed", async () => {
      const s = await station("CP16-INVALID", "OCPP-1.6J", [
        "StartTransaction",
      ]);
      try {
        void s.cp.startTransaction("TAG-16", 1);
        const start = await s.csms.waitForCall("StartTransaction");
        s.csms.replyCallResult(start.messageId, {
          transactionId: 7,
          idTagInfo: { status: "Invalid" },
        });
        await s.csms.waitForCall("StopTransaction");

        expect(s.sessions()).toMatchObject([
          {
            transactionId: "7",
            stopReason: "DeAuthorized",
            authorizationStatus: "Invalid",
            outcome: "failed",
          },
        ]);
      } finally {
        await s.stop();
      }
    });
  });

  describe("OCPP 2.0.1", () => {
    it("records a normal session with the station-minted id and the Ended reasons", async () => {
      const s = await station("CP201-NORMAL", "OCPP-2.0.1", []);
      try {
        s.cp.getConnector(1)!.meterValue = 200;
        void s.cp.startTransaction("TAG-201", 1);
        const started = await s.csms.waitForFrame(transactionEvent("Started"));
        const wireId = (started[3] as TransactionEventRequestV201)
          .transactionInfo.transactionId;
        expect(s.sessions()).toMatchObject([
          { outcome: "active", transactionId: wireId },
        ]);

        s.cp.getConnector(1)!.meterValue = 7200;
        s.cp.stopTransaction(1, "Remote", { triggerReason: "RemoteStop" });
        await s.csms.waitForFrame(transactionEvent("Ended"));

        expect(s.sessions()).toMatchObject([
          {
            evseId: 1,
            ocppVersion: "OCPP-2.0.1",
            transactionId: wireId,
            idTag: "TAG-201",
            energyWh: 7000,
            stopReason: "Remote",
            triggerReason: "RemoteStop",
            outcome: "completed",
          },
        ]);
      } finally {
        await s.stop();
      }
    });

    it("records a session stopped by a hard reset as interrupted, with the 2.x reason", async () => {
      const s = await station("CP201-RESET", "OCPP-2.0.1", []);
      try {
        void s.cp.startTransaction("TAG-201", 1);
        await s.csms.waitForFrame(transactionEvent("Started"));
        s.cp.stopTransaction(1, "HardReset");
        await s.csms.waitForFrame(transactionEvent("Ended"));

        expect(s.sessions()).toMatchObject([
          {
            stopReason: "ImmediateReset",
            triggerReason: "StopAuthorized",
            outcome: "interrupted",
          },
        ]);
      } finally {
        await s.stop();
      }
    });

    it("records an idToken the CSMS rejected, and stopped on, as failed", async () => {
      const s = await station("CP201-INVALID", "OCPP-2.0.1", [
        "TransactionEvent",
      ]);
      try {
        void s.cp.startTransaction("TAG-201", 1);
        const started = await s.csms.waitForFrame(transactionEvent("Started"));
        s.csms.replyCallResult(started[1] as string, {
          idTokenInfo: { status: "Invalid" },
        });
        await s.csms.waitForFrame(transactionEvent("Ended"));

        expect(s.sessions()).toMatchObject([
          {
            stopReason: "DeAuthorized",
            triggerReason: "Deauthorized",
            authorizationStatus: "Invalid",
            outcome: "failed",
          },
        ]);
      } finally {
        await s.stop();
      }
    });
  });
});

describe("ChargingSessionRecorder.reconcile (#447)", () => {
  const startTime = new Date("2026-10-28T09:00:00.000Z");

  function offlineChargePoint(id: string): ChargePoint {
    const cp = new ChargePoint(
      id,
      DefaultBootNotification,
      2,
      "ws://127.0.0.1:1/ocpp",
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      {},
    );
    cp.events.on("error", () => undefined);
    return cp;
  }

  /** What a daemon restore does: the transaction is back, no event fired. */
  function restoreTransaction(cp: ChargePoint, connectorId: number): void {
    cp.getConnector(connectorId)!.beginTransaction({
      id: 42,
      connectorId,
      tagId: "TAG",
      meterStart: 100,
      meterStop: null,
      startTime,
      stopTime: null,
      meterSent: false,
    });
  }

  function unendedSession(
    overrides: Partial<ChargingSession> = {},
  ): ChargingSession {
    return activeChargingSession({
      cpId: "CP-RESTORE",
      idTag: "TAG",
      startedAt: startTime.toISOString(),
      meterStartWh: 100,
      ...overrides,
    });
  }

  it("keeps a session whose transaction was restored active, under its own id", () => {
    const repo = new InMemoryChargingSessionRepository();
    repo.upsert(unendedSession());
    const cp = offlineChargePoint("CP-RESTORE");
    restoreTransaction(cp, 1);
    const recorder = new ChargingSessionRecorder(cp, repo);

    recorder.reconcile();

    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toEqual([
      unendedSession(),
    ]);

    // …and the restored session still ends normally.
    cp.stopTransaction(1);
    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toMatchObject([
      { sessionId: "s-1", outcome: "completed", stopReason: "Local" },
    ]);
    recorder.dispose();
    cp.dispose();
  });

  it("marks a session whose transaction did not come back interrupted, its end unknown", () => {
    const repo = new InMemoryChargingSessionRepository();
    repo.upsert(unendedSession());
    const cp = offlineChargePoint("CP-RESTORE");
    const recorder = new ChargingSessionRecorder(cp, repo);

    recorder.reconcile();

    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toEqual([
      unendedSession({ outcome: "interrupted" }),
    ]);
    recorder.dispose();
    cp.dispose();
  });

  it("revives an interrupted session once its transaction is restored", () => {
    const repo = new InMemoryChargingSessionRepository();
    repo.upsert(unendedSession({ outcome: "interrupted" }));
    const cp = offlineChargePoint("CP-RESTORE");
    const recorder = new ChargingSessionRecorder(cp, repo);
    recorder.reconcile();
    restoreTransaction(cp, 1);

    recorder.reconcile();

    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toEqual([
      unendedSession(),
    ]);
    recorder.dispose();
    cp.dispose();
  });

  it("opens a session for a restored transaction it has no record of", () => {
    const repo = new InMemoryChargingSessionRepository();
    const cp = offlineChargePoint("CP-RESTORE");
    restoreTransaction(cp, 2);
    const recorder = new ChargingSessionRecorder(cp, repo, {
      newSessionId: () => "s-new",
    });

    recorder.reconcile();

    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toEqual([
      unendedSession({ sessionId: "s-new", connectorId: 2 }),
    ]);
    recorder.dispose();
    cp.dispose();
  });

  it("marks the session of a removed connector interrupted", () => {
    const repo = new InMemoryChargingSessionRepository();
    repo.upsert(unendedSession({ connectorId: 2 }));
    const cp = offlineChargePoint("CP-RESTORE");
    restoreTransaction(cp, 2);
    const recorder = new ChargingSessionRecorder(cp, repo);
    recorder.reconcile();

    cp.removeConnector(2);

    expect(repo.list({ cpId: "CP-RESTORE" }).sessions).toEqual([
      unendedSession({ connectorId: 2, outcome: "interrupted" }),
    ]);
    recorder.dispose();
    cp.dispose();
  });
});
