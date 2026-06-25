import { describe, expect, it } from "bun:test";
import type {
  TransactionEventRequestV201,
  UnlockConnectorRequestV201,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function transactionEventFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType;
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

async function bootAccepted(csms: MockCsms): Promise<void> {
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
      (frame[3] as { evseId?: number; connectorId?: number }).evseId === 1 &&
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId ===
        1 &&
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

function newChargePoint(id: string): {
  csms: MockCsms;
  chargePoint: ChargePoint;
} {
  const csms = startMockCsms();
  const chargePoint = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
  );
  chargePoint.events.on("error", () => undefined);
  return { csms, chargePoint };
}

async function startTransaction(
  csms: MockCsms,
  chargePoint: ChargePoint,
): Promise<{ transactionId: string; numericTransactionId: number }> {
  const beforeStartIndex = csms.received.length - 1;
  chargePoint.startTransaction("TAG-201", 1);
  const startedFrame = await csms.waitForFrame(
    transactionEventFrameAfter(csms, beforeStartIndex, "Started"),
  );
  const started = startedFrame[3] as TransactionEventRequestV201;
  const connector = chargePoint.getConnector(1);
  const transaction = connector?.transaction;
  expect(transaction?.cpTransactionId).toBe(
    started.transactionInfo.transactionId,
  );

  return {
    transactionId: started.transactionInfo.transactionId,
    numericTransactionId: transaction?.id ?? 0,
  };
}

function sendUnlockConnector(
  csms: MockCsms,
  messageId: string,
  payload: UnlockConnectorRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "UnlockConnector", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

describe("OCPP 2.0.1 scenario parity", () => {
  it("routes RequestStopTransaction to the scenario stop trigger when armed", async () => {
    const { csms, chargePoint } = newChargePoint("CP201-SCENARIO-STOP");
    const remoteStopReceived = new Promise<{
      connectorId: number;
      transactionId: number;
    }>((resolve) => {
      chargePoint.events.once("remoteStopReceived", resolve);
    });

    try {
      chargePoint.connect();
      await bootAccepted(csms);
      const { transactionId, numericTransactionId } = await startTransaction(
        csms,
        chargePoint,
      );

      chargePoint.registerScenarioStopHandler(1);
      csms.send([
        2,
        "scenario-stop-201",
        "RequestStopTransaction",
        { transactionId },
      ]);

      const stopResult = await csms.waitForFrame(
        callResultFrame("scenario-stop-201"),
      );
      expect(stopResult).toEqual([
        3,
        "scenario-stop-201",
        { status: "Accepted" },
      ]);
      await expect(remoteStopReceived).resolves.toEqual({
        connectorId: 1,
        transactionId: numericTransactionId,
      });
      expect(chargePoint.getConnector(1)?.transaction).toBeTruthy();

      await expectNoFrame(
        csms,
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(stopResult),
          "Ended",
        ),
      );
    } finally {
      chargePoint.unregisterScenarioStopHandler(1);
      chargePoint.disconnect();
      await csms.stop();
    }
  });

  it("keeps the non-scenario RequestStopTransaction path stopping as Remote", async () => {
    const { csms, chargePoint } = newChargePoint("CP201-NON-SCENARIO-STOP");

    try {
      chargePoint.connect();
      await bootAccepted(csms);
      const { transactionId } = await startTransaction(csms, chargePoint);

      csms.send([
        2,
        "non-scenario-stop-201",
        "RequestStopTransaction",
        { transactionId },
      ]);

      const stopResult = await csms.waitForFrame(
        callResultFrame("non-scenario-stop-201"),
      );
      expect(stopResult).toEqual([
        3,
        "non-scenario-stop-201",
        { status: "Accepted" },
      ]);

      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(stopResult),
          "Ended",
        ),
      );
      const ended = endedFrame[3] as TransactionEventRequestV201;
      expect(ended.transactionInfo.transactionId).toBe(transactionId);
      expect(ended.transactionInfo.stoppedReason).toBe("Remote");
    } finally {
      chargePoint.disconnect();
      await csms.stop();
    }
  });

  it("honors scenario-armed UnlockConnector outcomes for idle connectors", async () => {
    const { csms, chargePoint } = newChargePoint("CP201-SCENARIO-UNLOCK");
    const connector = chargePoint.getConnector(1);
    expect(connector).toBeDefined();

    try {
      chargePoint.connect();
      await bootAccepted(csms);

      connector!.unlockResponse = "UnlockFailed";
      const failedResult = await sendUnlockConnector(
        csms,
        "scenario-unlock-failed",
        {
          evseId: 1,
          connectorId: 1,
        },
      );
      expect(failedResult).toEqual([
        3,
        "scenario-unlock-failed",
        { status: "UnlockFailed" },
      ]);

      connector!.unlockResponse = "Unlocked";
      const unlockedResult = await sendUnlockConnector(
        csms,
        "scenario-unlock-ok",
        {
          evseId: 1,
          connectorId: 1,
        },
      );
      expect(unlockedResult).toEqual([
        3,
        "scenario-unlock-ok",
        { status: "Unlocked" },
      ]);
    } finally {
      connector!.unlockResponse = "Unlocked";
      chargePoint.disconnect();
      await csms.stop();
    }
  });
});
