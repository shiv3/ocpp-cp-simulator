import { describe, expect, it } from "bun:test";
import type {
  ResetRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import type { ResetRequestV21 } from "../../../../ocpp/v21";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
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

function transactionEventFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    callFrameAfter(csms, afterIndex, "TransactionEvent")(frame) &&
    (frame[3] as { eventType?: string }).eventType === eventType;
}

function transactionEventPayload(
  frame: OcppFrame,
): TransactionEventRequestV201 {
  return frame[3] as TransactionEventRequestV201;
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
    interval: 0,
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

async function bootAcceptedAfter(
  csms: MockCsms,
  afterIndex: number,
): Promise<void> {
  const boot = await csms.waitForFrame(
    callFrameAfter(csms, afterIndex, "BootNotification"),
  );
  csms.replyCallResult(boot[1] as string, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 0,
  });

  const bootIndex = csms.received.indexOf(boot);
  await csms.waitForFrame(
    (frame) =>
      csms.received.indexOf(frame) > bootIndex &&
      frame[0] === 2 &&
      frame[2] === "StatusNotification" &&
      (frame[3] as { evseId?: number; connectorId?: number }).evseId === 1 &&
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId ===
        1 &&
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

function newChargePoint(
  id: string,
  version = "OCPP-2.0.1",
): {
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
    version,
  );
  cp.events.on("error", () => undefined);
  return { csms, cp };
}

async function sendReset(
  csms: MockCsms,
  messageId: string,
  payload: ResetRequestV201 | ResetRequestV21,
): Promise<OcppFrame> {
  csms.send([2, messageId, "Reset", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

describe("OCPP 2.0.1 Reset", () => {
  it("accepts Immediate while idle and sends BootNotification after the CALLRESULT", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-IMMEDIATE-IDLE");

    try {
      cp.connect();
      await bootAccepted(csms);

      const result = await sendReset(csms, "reset-immediate", {
        type: "Immediate",
      });
      expect(result).toEqual([3, "reset-immediate", { status: "Accepted" }]);

      const resultIndex = csms.received.indexOf(result);
      const boot = await csms.waitForFrame(
        callFrameAfter(csms, resultIndex, "BootNotification"),
      );
      expect(csms.received.indexOf(boot)).toBeGreaterThan(resultIndex);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("accepts OnIdle while idle and sends BootNotification after the CALLRESULT", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-IDLE");

    try {
      cp.connect();
      await bootAccepted(csms);

      const result = await sendReset(csms, "reset-onidle-idle", {
        type: "OnIdle",
      });
      expect(result).toEqual([3, "reset-onidle-idle", { status: "Accepted" }]);

      const resultIndex = csms.received.indexOf(result);
      const boot = await csms.waitForFrame(
        callFrameAfter(csms, resultIndex, "BootNotification"),
      );
      expect(csms.received.indexOf(boot)).toBeGreaterThan(resultIndex);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("schedules OnIdle with an active transaction and does not reboot now", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-ACTIVE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-onidle-active", {
        type: "OnIdle",
      });
      expect(result).toEqual([
        3,
        "reset-onidle-active",
        { status: "Scheduled" },
      ]);

      await expectNoFrame(
        csms,
        callFrameAfter(csms, csms.received.indexOf(result), "BootNotification"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("accepts Immediate with an active transaction, ends it, then reboots", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-IMMEDIATE-ACTIVE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-immediate-active", {
        type: "Immediate",
      });
      expect(result).toEqual([
        3,
        "reset-immediate-active",
        { status: "Accepted" },
      ]);

      const resultIndex = csms.received.indexOf(result);
      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
      const boot = await csms.waitForFrame(
        callFrameAfter(csms, resultIndex, "BootNotification"),
      );
      const ended = transactionEventPayload(endedFrame);

      expect(ended.transactionInfo.stoppedReason).toBe("ImmediateReset");
      expect(ended.triggerReason).toBe("ResetCommand");
      expect(csms.received.indexOf(endedFrame)).toBeGreaterThan(resultIndex);
      expect(csms.received.indexOf(boot)).toBeGreaterThan(
        csms.received.indexOf(endedFrame),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps ChargePoint connector listeners alive across reset for target-SoC auto-stop", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-LISTENER-SURVIVAL");

    try {
      cp.connect();
      await bootAccepted(csms);

      const beforeResetIndex = csms.received.length - 1;
      cp.reset();
      await bootAcceptedAfter(csms, beforeResetIndex);

      const connector = cp.getConnector(1);
      expect(connector).toBeDefined();
      connector!.evSettings = {
        ...connector!.evSettings,
        batteryCapacityKwh: 50,
        initialSoc: 10,
        targetSoc: 20,
      };
      connector!.autoMeterValueConfig = {
        enabled: true,
        curvePoints: [
          { time: 0, value: 0 },
          { time: 3600, value: 50 },
        ],
        intervalSeconds: 60,
        autoCalculateInterval: false,
        stopAtTargetSoc: true,
      };

      const beforeStartIndex = csms.received.length - 1;
      cp.startTransaction("TAG-RESET-LISTENER", 1, 50, 10);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(csms, beforeStartIndex, "Started"),
      );

      connector!.soc = 20;
      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(startedFrame),
          "Ended",
        ),
      );
      const ended = transactionEventPayload(endedFrame);

      expect(ended.transactionInfo.transactionId).toBe(
        transactionEventPayload(startedFrame).transactionInfo.transactionId,
      );
      expect(ended.triggerReason).toBe("EnergyLimitReached");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("accepts v21 ImmediateAndResume without ending the active transaction", async () => {
    const { csms, cp } = newChargePoint(
      "CP21-RESET-IMMEDIATE-AND-RESUME",
      "OCPP-2.1",
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-21", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-immediate-and-resume", {
        type: "ImmediateAndResume",
      });
      expect(result).toEqual([
        3,
        "reset-immediate-and-resume",
        { status: "Accepted" },
      ]);

      const resultIndex = csms.received.indexOf(result);
      const boot = await csms.waitForFrame(
        callFrameAfter(csms, resultIndex, "BootNotification"),
      );
      expect(csms.received.indexOf(boot)).toBeGreaterThan(resultIndex);
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
