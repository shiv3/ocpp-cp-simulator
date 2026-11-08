import { describe, expect, it } from "bun:test";
import type {
  ResetRequestV201,
  TransactionEventRequestV201,
} from "@ocpp-cp-sim/ocpp/index";
import type { ResetRequestV21 } from "@ocpp-cp-sim/ocpp/v21/index";
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

/** An EVSE-scoped reset reports the EVSE Unavailable (B11.FR.08), no boot. */
function evseUnavailableAfter(
  csms: MockCsms,
  afterIndex: number,
  evseId: number,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === "StatusNotification" &&
    (frame[3] as { evseId?: number }).evseId === evseId &&
    (frame[3] as { connectorStatus?: string }).connectorStatus ===
      "Unavailable";
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
  connectorStatus = "Available",
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
        connectorStatus,
  );
}

function newChargePoint(
  id: string,
  version = "OCPP-2.0.1",
  connectorCount = 1,
): {
  csms: MockCsms;
  cp: ChargePoint;
} {
  const csms = startMockCsms({ answerCalls: true });
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    connectorCount,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  // This suite exercises Reset semantics, not the #181 local-authorize
  // gate — disable it so the setup `startTransaction()` calls below don't
  // wait on an Authorize.conf the mock CSMS never answers.
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
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

  it("runs a scheduled OnIdle reset once the last transaction ends (#597)", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-RUNS");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-onidle-runs", {
        type: "OnIdle",
      });
      expect(result).toEqual([3, "reset-onidle-runs", { status: "Scheduled" }]);

      const resultIndex = csms.received.indexOf(result);
      cp.stopTransaction(1, "Local");
      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
      const boot = await csms.waitForFrame(
        callFrameAfter(
          csms,
          csms.received.indexOf(endedFrame),
          "BootNotification",
        ),
      );
      expect(csms.received.indexOf(boot)).toBeGreaterThan(
        csms.received.indexOf(endedFrame),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("does not treat a retained stopped transaction as busy for OnIdle", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-STOPPED-ATTACHED");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.getConnector(1)!.transaction!.stopTime = new Date();

      cp.scheduleResetOnIdle(1);
      await csms.waitForCall("BootNotification");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("rechecks an OnIdle reset enqueued after the transaction already ended", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-LATE-QUEUE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.stopTransaction(1, "Local");
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Ended"));

      const afterEnd = csms.received.length - 1;
      cp.scheduleResetOnIdle(1);
      await csms.waitForFrame(evseUnavailableAfter(csms, afterEnd, 1));
      await expectNoFrame(
        csms,
        callFrameAfter(csms, afterEnd, "BootNotification"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps an Inoperative connector unavailable across a scheduled reset", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-INOPERATIVE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      csms.send([
        2,
        "change-inoperative",
        "ChangeAvailability",
        { operationalStatus: "Inoperative", evse: { id: 1 } },
      ]);
      expect(
        await csms.waitForFrame(callResultFrame("change-inoperative")),
      ).toEqual([3, "change-inoperative", { status: "Scheduled" }]);
      const reset = await sendReset(csms, "reset-inoperative", {
        type: "OnIdle",
        evseId: 1,
      });
      expect(reset).toEqual([3, "reset-inoperative", { status: "Scheduled" }]);

      const beforeStop = csms.received.length - 1;
      cp.stopTransaction(1, "Local");
      const ended = await csms.waitForFrame(
        transactionEventFrameAfter(csms, beforeStop, "Ended"),
      );
      // The EVSE reset keeps an Inoperative EVSE Unavailable (B11.FR.02) and
      // does not reboot the station.
      await csms.waitForFrame(
        evseUnavailableAfter(csms, csms.received.indexOf(ended), 1),
      );
      expect((await cp.startTransaction("TAG-202", 1)).started).toBe(false);
      await expectNoFrame(
        csms,
        callFrameAfter(csms, csms.received.indexOf(ended), "BootNotification"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("runs an EVSE-scoped OnIdle reset once that EVSE's transaction ends (#597)", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-EVSE");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-onidle-evse", {
        type: "OnIdle",
        evseId: 1,
      });
      expect(result).toEqual([3, "reset-onidle-evse", { status: "Scheduled" }]);

      const resultIndex = csms.received.indexOf(result);
      cp.stopTransaction(1, "Local");
      const endedFrame = await csms.waitForFrame(
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
      await csms.waitForFrame(
        evseUnavailableAfter(csms, csms.received.indexOf(endedFrame), 1),
      );
      await expectNoFrame(
        csms,
        callFrameAfter(
          csms,
          csms.received.indexOf(endedFrame),
          "BootNotification",
        ),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps a scheduled OnIdle reset pending while another targeted transaction runs (#597)", async () => {
    const { csms, cp } = newChargePoint(
      "CP201-RESET-ONIDLE-WAITS",
      "OCPP-2.0.1",
      2,
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.startTransaction("TAG-202", 2);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-onidle-waits", {
        type: "OnIdle",
      });
      expect(result).toEqual([
        3,
        "reset-onidle-waits",
        { status: "Scheduled" },
      ]);

      const resultIndex = csms.received.indexOf(result);
      cp.stopTransaction(1, "Local");
      const firstEnded = await csms.waitForFrame(
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
      await expectNoFrame(
        csms,
        callFrameAfter(
          csms,
          csms.received.indexOf(firstEnded),
          "BootNotification",
        ),
      );

      cp.stopTransaction(2, "Local");
      const secondEnded = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(firstEnded),
          "Ended",
        ),
      );
      await csms.waitForFrame(
        callFrameAfter(
          csms,
          csms.received.indexOf(secondEnded),
          "BootNotification",
        ),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("keeps two scheduled OnIdle resets for different EVSEs until each runs (#597)", async () => {
    const { csms, cp } = newChargePoint(
      "CP201-RESET-ONIDLE-TWO",
      "OCPP-2.0.1",
      2,
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.startTransaction("TAG-202", 2);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const first = await sendReset(csms, "reset-onidle-evse1", {
        type: "OnIdle",
        evseId: 1,
      });
      expect(first).toEqual([3, "reset-onidle-evse1", { status: "Scheduled" }]);
      const second = await sendReset(csms, "reset-onidle-evse2", {
        type: "OnIdle",
        evseId: 2,
      });
      expect(second).toEqual([
        3,
        "reset-onidle-evse2",
        { status: "Scheduled" },
      ]);

      // EVSE 1 is idle first: its reset must still run although EVSE 2
      // was scheduled after it.
      cp.stopTransaction(1, "Local");
      const firstEnded = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(second),
          "Ended",
        ),
      );
      await csms.waitForFrame(
        evseUnavailableAfter(csms, csms.received.indexOf(firstEnded), 1),
      );
      expect(
        csms.received.some(
          (frame, i) =>
            i > csms.received.indexOf(firstEnded) &&
            evseUnavailableAfter(csms, -1, 2)(frame),
        ),
      ).toBe(false);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("an Immediate reset supersedes a scheduled OnIdle reset: one reboot, no later one (#597)", async () => {
    const { csms, cp } = newChargePoint("CP201-RESET-ONIDLE-SUPERSEDED");

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const scheduled = await sendReset(csms, "reset-onidle-first", {
        type: "OnIdle",
      });
      expect(scheduled).toEqual([
        3,
        "reset-onidle-first",
        { status: "Scheduled" },
      ]);

      const immediate = await sendReset(csms, "reset-immediate-second", {
        type: "Immediate",
      });
      expect(immediate).toEqual([
        3,
        "reset-immediate-second",
        { status: "Accepted" },
      ]);

      const immediateIndex = csms.received.indexOf(immediate);
      const ended = await csms.waitForFrame(
        transactionEventFrameAfter(csms, immediateIndex, "Ended"),
      );
      const boot = await csms.waitForFrame(
        callFrameAfter(csms, csms.received.indexOf(ended), "BootNotification"),
      );
      const bootIndex = csms.received.indexOf(boot);
      csms.replyCallResult(boot[1] as string, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 0,
      });

      await expectNoFrame(
        csms,
        callFrameAfter(csms, bootIndex, "BootNotification"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("a scoped Immediate reset preserves a pending OnIdle reset for another EVSE", async () => {
    const { csms, cp } = newChargePoint(
      "CP201-RESET-ONIDLE-SCOPED-CANCEL",
      "OCPP-2.0.1",
      2,
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.startTransaction("TAG-202", 2);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      expect(
        await sendReset(csms, "reset-onidle-evse2-pending", {
          type: "OnIdle",
          evseId: 2,
        }),
      ).toEqual([3, "reset-onidle-evse2-pending", { status: "Scheduled" }]);

      const immediate = await sendReset(csms, "reset-immediate-evse1", {
        type: "Immediate",
        evseId: 1,
      });
      expect(immediate).toEqual([
        3,
        "reset-immediate-evse1",
        { status: "Accepted" },
      ]);
      const firstEnded = await csms.waitForFrame(
        transactionEventFrameAfter(
          csms,
          csms.received.indexOf(immediate),
          "Ended",
        ),
      );
      // The scoped reset cycles EVSE 1 only (B11.FR.08): no boot, and the
      // reset pending for EVSE 2 is still queued.
      await csms.waitForFrame(
        evseUnavailableAfter(csms, csms.received.indexOf(firstEnded), 1),
      );

      const beforeSecondStop = csms.received.length - 1;
      cp.stopTransaction(2, "Local");
      const secondEnded = await csms.waitForFrame(
        transactionEventFrameAfter(csms, beforeSecondStop, "Ended"),
      );
      await csms.waitForFrame(
        evseUnavailableAfter(csms, csms.received.indexOf(secondEnded), 2),
      );
      await expectNoFrame(
        csms,
        callFrameAfter(
          csms,
          csms.received.indexOf(immediate),
          "BootNotification",
        ),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("rechecks an unscoped OnIdle reset when a connector is removed", async () => {
    const { csms, cp } = newChargePoint(
      "CP201-RESET-ONIDLE-REMOVE",
      "OCPP-2.0.1",
      2,
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      cp.startTransaction("TAG-202", 2);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));
      expect(
        await sendReset(csms, "reset-onidle-remove", { type: "OnIdle" }),
      ).toEqual([3, "reset-onidle-remove", { status: "Scheduled" }]);

      const beforeRemoval = csms.received.length - 1;
      cp.removeConnector(1);
      await expectNoFrame(
        csms,
        callFrameAfter(csms, beforeRemoval, "BootNotification"),
      );
      cp.stopTransaction(2, "Local");
      const ended = await csms.waitForFrame(
        transactionEventFrameAfter(csms, -1, "Ended"),
      );
      await csms.waitForFrame(
        callFrameAfter(csms, csms.received.indexOf(ended), "BootNotification"),
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

  it("rejects v21 ImmediateAndResume while a transaction runs (B13.FR.01)", async () => {
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
        { status: "Rejected" },
      ]);

      const resultIndex = csms.received.indexOf(result);
      await expectNoFrame(
        csms,
        callFrameAfter(csms, resultIndex, "BootNotification"),
      );
      await expectNoFrame(
        csms,
        transactionEventFrameAfter(csms, resultIndex, "Ended"),
      );
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("accepts v21 ImmediateAndResume as an Immediate reset without a transaction (B13.FR.02)", async () => {
    const { csms, cp } = newChargePoint(
      "CP21-RESET-IMMEDIATE-AND-RESUME-IDLE",
      "OCPP-2.1",
    );

    try {
      cp.connect();
      await bootAccepted(csms);

      const result = await sendReset(csms, "reset-resume-idle", {
        type: "ImmediateAndResume",
      });
      expect(result).toEqual([3, "reset-resume-idle", { status: "Accepted" }]);
      await csms.waitForFrame(
        callFrameAfter(csms, csms.received.indexOf(result), "BootNotification"),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("rejects v21 ImmediateAndResume with an evseId while another EVSE charges (B13.FR.01/02)", async () => {
    const { csms, cp } = newChargePoint(
      "CP21-RESET-RESUME-OTHER-EVSE",
      "OCPP-2.1",
      2,
    );

    try {
      cp.connect();
      await bootAccepted(csms);
      cp.startTransaction("TAG-21", 2);
      await csms.waitForFrame(transactionEventFrameAfter(csms, -1, "Started"));

      const result = await sendReset(csms, "reset-resume-evse1", {
        type: "ImmediateAndResume",
        evseId: 1,
      });
      expect(result).toEqual([3, "reset-resume-evse1", { status: "Rejected" }]);
      expect(cp.getConnector(2)?.hasRunningTransaction).toBe(true);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
