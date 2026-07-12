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
  cp: ChargePoint;
} {
  const csms = startMockCsms();
  const cp = new ChargePoint(
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
    {},
  );
  cp.events.on("error", () => undefined);
  // This suite exercises UnlockConnector semantics, not the #181 local-
  // authorize gate — disable it so the setup `startTransaction()` call
  // below doesn't wait on an Authorize.conf the mock CSMS never answers.
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  return { csms, cp };
}

function sendUnlockConnector(
  csms: MockCsms,
  messageId: string,
  payload: UnlockConnectorRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "UnlockConnector", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

describe("OCPP 2.0.1 UnlockConnector", () => {
  it("returns Unlocked for an idle known connector", async () => {
    const { csms, cp } = newChargePoint("CP201-UNLOCK-IDLE");

    try {
      cp.connect();
      await bootAccepted(csms);

      const result = await sendUnlockConnector(csms, "unlock-idle", {
        evseId: 1,
        connectorId: 1,
      });

      expect(result).toEqual([3, "unlock-idle", { status: "Unlocked" }]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("returns UnknownConnector for an unknown evseId", async () => {
    const { csms, cp } = newChargePoint("CP201-UNLOCK-UNKNOWN");

    try {
      cp.connect();
      await bootAccepted(csms);

      const result = await sendUnlockConnector(csms, "unlock-unknown", {
        evseId: 99,
        connectorId: 1,
      });

      expect(result).toEqual([
        3,
        "unlock-unknown",
        { status: "UnknownConnector" },
      ]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("returns OngoingAuthorizedTransaction without stopping an active transaction", async () => {
    const { csms, cp } = newChargePoint("CP201-UNLOCK-ACTIVE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendUnlockConnector(csms, "unlock-active", {
        evseId: 1,
        connectorId: 1,
      });

      expect(result).toEqual([
        3,
        "unlock-active",
        { status: "OngoingAuthorizedTransaction" },
      ]);
      expect(cp.getConnector(1)?.transaction).toBeTruthy();

      await expectNoFrame(
        csms,
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(result),
          "Ended",
        ),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
