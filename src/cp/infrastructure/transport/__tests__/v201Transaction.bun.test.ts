import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import {
  startMockCsms,
  normalizeTranscript,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import type { Transaction } from "../../../domain/connector/Transaction";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import { SqliteConnectorRuntimeRepository } from "../../../domain/persistence/SqliteConnectorRuntimeRepository";

function transactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType;
}

function transactionEventPayload(
  frame: OcppFrame,
): TransactionEventRequestV201 {
  return frame[3] as TransactionEventRequestV201;
}

function meterValuesPayload(frame: OcppFrame): MeterValuesRequestV201 {
  return frame[3] as MeterValuesRequestV201;
}

function receivedMessageIds(csms: MockCsms): Set<unknown> {
  return new Set(csms.received.map((frame) => frame[1]));
}

function newTransactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
  seenMessageIds: Set<unknown>,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    transactionEventFrame(eventType)(frame) && !seenMessageIds.has(frame[1]);
}

function transactionEventFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    transactionEventFrame(eventType)(frame);
}

function statusNotificationFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  connectorId: number,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === "StatusNotification" &&
    (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
      connectorId &&
    (frame[3] as { evseId?: number; connectorId?: number }).connectorId ===
      connectorId;
}

function callFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  action: string,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === action;
}

async function expectNoFrame(
  csms: MockCsms,
  pred: (frame: OcppFrame) => boolean,
): Promise<void> {
  try {
    const frame = await csms.waitForFrame(pred, 150);
    throw new Error(`Unexpected frame: ${JSON.stringify(frame)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Timed out waiting for frame"
    ) {
      return;
    }
    throw error;
  }
}

function attachConnectorRuntimePersistence(
  repo: SqliteConnectorRuntimeRepository,
  cpId: string,
  cp: ChargePoint,
  connectorId: number,
): Array<() => void> {
  const connector = cp.getConnector(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const persist = () => {
    repo.save(cpId, connectorId, {
      ...connector.snapshotRuntime(),
      scenarioPosition: null,
    });
  };
  return [
    connector.events.on("statusChange", persist),
    connector.events.on("availabilityChange", persist),
    connector.events.on("transactionChange", persist),
    connector.events.on("transactionIdChange", persist),
    connector.events.on("meterValueChange", persist),
    connector.events.on("socChange", persist),
  ];
}

describe("OCPP 2.0.1 transaction events", () => {
  it("sends TransactionEvent and MeterValues with stable transaction id and numeric values", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 1,
      );

      cp.startTransaction("TAG-201", 1);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      const started = transactionEventPayload(startedFrame);
      const transaction = cp.getConnector(1)?.transaction;
      if (!transaction?.cpTransactionId) {
        throw new Error("Expected v201 transaction to have cpTransactionId");
      }
      expect(started.transactionInfo.transactionId).toBe(
        transaction.cpTransactionId,
      );
      expect(started.triggerReason).toBe("Authorized");
      expect(started.transactionInfo.remoteStartId).toBeUndefined();
      expect(started.reservationId).toBeUndefined();

      cp.sendMeterValue(1);
      const meterValuesFrame = await csms.waitForFrame(
        (frame) => frame[0] === 2 && frame[2] === "MeterValues",
      );

      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrame("Ended"),
      );

      const relevantFrames = csms.received.filter(
        (frame) =>
          frame[0] === 2 &&
          (frame[2] === "TransactionEvent" || frame[2] === "MeterValues"),
      );
      expect(
        relevantFrames.map((frame) =>
          frame[2] === "TransactionEvent"
            ? `TransactionEvent:${(frame[3] as { eventType: string }).eventType}`
            : "MeterValues",
        ),
      ).toEqual([
        "TransactionEvent:Started",
        "MeterValues",
        "TransactionEvent:Ended",
      ]);

      const meterValues = meterValuesPayload(meterValuesFrame);
      const ended = transactionEventPayload(endedFrame);
      expect(started.transactionInfo.transactionId).toBe(
        ended.transactionInfo.transactionId,
      );
      expect(ended.triggerReason).toBe("StopAuthorized");
      expect(ended.idToken).toEqual({
        idToken: "TAG-201",
        type: "ISO14443",
      });

      const seqNos = [started.seqNo, ended.seqNo];
      expect(seqNos.every((seqNo) => Number.isInteger(seqNo))).toBe(true);
      expect(seqNos[1]).toBeGreaterThan(seqNos[0]);

      const sampledValues = [
        ...(started.meterValue?.[0].sampledValue ?? []),
        ...meterValues.meterValue[0].sampledValue,
        ...(ended.meterValue?.[0].sampledValue ?? []),
      ];
      expect(sampledValues.length).toBeGreaterThan(0);
      for (const sampledValue of sampledValues) {
        expect(typeof sampledValue.value).toBe("number");
      }

      expect(normalizeTranscript(relevantFrames)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("sends TransactionEvent Updated when active chargingState changes", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-CHARGING-STATE",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 1,
      );

      cp.startTransaction("TAG-201", 1);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      const started = transactionEventPayload(startedFrame);
      const transactionId = started.transactionInfo.transactionId;

      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEVSE);
      const suspendedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(startedFrame),
          "Updated",
        ),
      );
      const suspended = transactionEventPayload(suspendedFrame);
      expect(suspended.triggerReason).toBe("ChargingStateChanged");
      expect(suspended.transactionInfo).toMatchObject({
        transactionId,
        chargingState: "SuspendedEVSE",
      });

      const beforeDuplicateSuspend = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEVSE);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeDuplicateSuspend, "Updated"),
      );

      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      const resumedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(suspendedFrame),
          "Updated",
        ),
      );
      const resumed = transactionEventPayload(resumedFrame);
      expect(resumed.triggerReason).toBe("ChargingStateChanged");
      expect(resumed.transactionInfo).toMatchObject({
        transactionId,
        chargingState: "Charging",
      });

      const beforeDuplicateResume = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeDuplicateResume, "Updated"),
      );

      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
      const suspendedEvFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(resumedFrame),
          "Updated",
        ),
      );
      const suspendedEv = transactionEventPayload(suspendedEvFrame);
      expect(suspendedEv.triggerReason).toBe("ChargingStateChanged");
      expect(suspendedEv.transactionInfo).toMatchObject({
        transactionId,
        chargingState: "SuspendedEV",
      });

      const beforeDuplicateSuspendedEv = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeDuplicateSuspendedEv, "Updated"),
      );

      const beforeRawStatus = csms.received.length - 1;
      cp.sendStatusNotificationRaw(1, OCPPStatus.SuspendedEV, {});
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeRawStatus, "Updated"),
      );

      const beforeFinishing = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.Finishing);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeFinishing, "Updated"),
      );

      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(suspendedEvFrame),
          "Ended",
        ),
      );
      const ended = transactionEventPayload(endedFrame);

      const beforeInactive = csms.received.length - 1;
      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, beforeInactive, "Updated"),
      );

      expect(started.seqNo).toBe(0);
      expect(suspended.seqNo).toBe(1);
      expect(resumed.seqNo).toBe(2);
      expect(suspendedEv.seqNo).toBe(3);
      expect(ended.seqNo).toBe(4);
      expect(ended.transactionInfo.transactionId).toBe(transactionId);

      const relevantFrames = csms.received.filter(
        (frame) => frame[0] === 2 && frame[2] === "TransactionEvent",
      );
      expect(
        relevantFrames.map((frame) => {
          const payload = transactionEventPayload(frame);
          const state = payload.transactionInfo.chargingState;
          return state
            ? `TransactionEvent:${payload.eventType}:${state}`
            : `TransactionEvent:${payload.eventType}`;
        }),
      ).toEqual([
        "TransactionEvent:Started:Charging",
        "TransactionEvent:Updated:SuspendedEVSE",
        "TransactionEvent:Updated:Charging",
        "TransactionEvent:Updated:SuspendedEV",
        "TransactionEvent:Ended",
      ]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("resets TransactionEvent seqNo for each new transaction", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-SEQ",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 1,
      );

      const beforeTx1Start = receivedMessageIds(csms);
      cp.startTransaction("TAG-201-A", 1);
      const tx1StartedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Started", beforeTx1Start),
      );
      const tx1Started = transactionEventPayload(tx1StartedFrame);

      const beforeTx1End = receivedMessageIds(csms);
      cp.stopTransaction(1);
      const tx1EndedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Ended", beforeTx1End),
      );
      const tx1Ended = transactionEventPayload(tx1EndedFrame);

      const beforeTx2Start = receivedMessageIds(csms);
      cp.startTransaction("TAG-201-B", 1);
      const tx2StartedFrame = await csms.waitForFrame(
        newTransactionEventFrame("Started", beforeTx2Start),
      );
      const tx2Started = transactionEventPayload(tx2StartedFrame);

      expect(tx1Started.seqNo).toBe(0);
      expect(tx1Ended.seqNo).toBe(1);
      expect(tx2Started.seqNo).toBe(0);
      expect(tx1Ended.transactionInfo.transactionId).toBe(
        tx1Started.transactionInfo.transactionId,
      );
      expect(tx2Started.transactionInfo.transactionId).not.toBe(
        tx1Started.transactionInfo.transactionId,
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps persisted transaction id when stopping after handler restart", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-TX-RESTORE",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    cp.events.on("error", () => undefined);

    const knownCpTransactionId = "cp-tx-known";
    const restoredTransaction: Transaction = {
      id: 0,
      connectorId: 1,
      tagId: "TAG-201",
      meterStart: 1000,
      meterStop: null,
      startTime: new Date("2026-06-24T00:01:00.000Z"),
      stopTime: null,
      meterSent: false,
      cpTransactionId: knownCpTransactionId,
      cpNextSeqNo: 1,
    };
    const restoredConnector = cp.getConnector(1);
    expect(restoredConnector).toBeDefined();
    restoredConnector?.restoreRuntimeSnapshot({
      status: OCPPStatus.Charging,
      availability: "Operative",
      scheduledAvailability: null,
      transaction: restoredTransaction,
      meterValueWh: 4321,
      socPercent: null,
      lastAutoStartedScenarioKey: null,
    });
    expect(restoredConnector?.transaction?.cpTransactionId).toBe(
      knownCpTransactionId,
    );
    expect(restoredConnector?.transaction?.cpNextSeqNo).toBe(1);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number; connectorStatus?: string }).evseId ===
            1 &&
          (frame[3] as { evseId?: number; connectorStatus?: string })
            .connectorStatus === "Occupied",
      );

      expect(restoredConnector?.transaction?.cpTransactionId).toBe(
        knownCpTransactionId,
      );
      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrame("Ended"),
      );
      const ended = transactionEventPayload(endedFrame);
      expect(ended.transactionInfo.transactionId).toBe(knownCpTransactionId);
      expect(ended.seqNo).toBe(1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("does not re-emit chargingState Updated or reuse seqNo after restart while suspended", async () => {
    const csms = startMockCsms();
    const db = BunSqliteDatabase.open(":memory:");
    const repo = new SqliteConnectorRuntimeRepository(db);
    const cpId = "CP201-TX-CHARGING-STATE-RESTART";
    const makeCp = () => {
      const cp = new ChargePoint(
        cpId,
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-2.0.1",
        {},
      );
      cp.events.on("error", () => undefined);
      return cp;
    };

    let cp1: ChargePoint | null = null;
    let cp2: ChargePoint | null = null;
    let unsubs: Array<() => void> = [];

    try {
      cp1 = makeCp();
      unsubs = attachConnectorRuntimePersistence(repo, cpId, cp1, 1);
      cp1.connect();

      const boot1 = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot1.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });
      await csms.waitForFrame(statusNotificationFrameAfter(csms, -1, 1));

      cp1.startTransaction("TAG-201", 1);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      const started = transactionEventPayload(startedFrame);
      const transactionId = started.transactionInfo.transactionId;

      cp1.updateConnectorStatus(1, OCPPStatus.SuspendedEVSE);
      const suspendedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(startedFrame),
          "Updated",
        ),
      );
      const suspended = transactionEventPayload(suspendedFrame);
      expect(suspended.seqNo).toBe(1);
      expect(suspended.transactionInfo).toMatchObject({
        transactionId,
        chargingState: "SuspendedEVSE",
      });

      const beforeRestartIndex = csms.received.length - 1;
      for (const unsub of unsubs) unsub();
      unsubs = [];
      cp1.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const restored = repo.load(cpId, 1);
      expect(restored?.transaction?.cpTransactionId).toBe(transactionId);

      cp2 = makeCp();
      unsubs = attachConnectorRuntimePersistence(repo, cpId, cp2, 1);
      const restoredConnector = cp2.getConnector(1);
      expect(restoredConnector).toBeDefined();
      restoredConnector?.restoreRuntimeSnapshot(restored!);
      cp2.connect();

      const boot2Frame = await csms.waitForFrame(
        callFrameAfter(csms, beforeRestartIndex, "BootNotification"),
      );
      csms.replyCallResult(boot2Frame[1] as string, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:01.000Z",
        interval: 300,
      });
      await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(boot2Frame),
          1,
        ),
      );

      await expectNoFrame(
        csms,
        (frame) =>
          transactionEventFrameAfter(
            csms,
            beforeRestartIndex,
            "Updated",
          )(frame) &&
          transactionEventPayload(frame).transactionInfo.transactionId ===
            transactionId &&
          transactionEventPayload(frame).transactionInfo.chargingState ===
            "SuspendedEVSE",
      );

      const beforeResumeIndex = csms.received.length - 1;
      cp2.updateConnectorStatus(1, OCPPStatus.Charging);
      const resumedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(csms, beforeResumeIndex, "Updated"),
      );
      const resumed = transactionEventPayload(resumedFrame);
      expect(resumed.seqNo).toBe(2);
      expect(resumed.transactionInfo).toMatchObject({
        transactionId,
        chargingState: "Charging",
      });

      const persistedAfterResume = repo.load(cpId, 1);
      expect(persistedAfterResume?.transaction?.cpNextSeqNo).toBe(3);
      expect(
        persistedAfterResume?.transaction?.cpLastTransactionEventChargingState,
      ).toBe("Charging");
    } finally {
      for (const unsub of unsubs) unsub();
      cp2?.disconnect();
      cp1?.disconnect();
      db.close();
      await csms.stop();
    }
  });
});
