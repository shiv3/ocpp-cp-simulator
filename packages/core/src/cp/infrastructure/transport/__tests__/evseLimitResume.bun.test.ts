import { describe, expect, it } from "bun:test";
import {
  answerTo,
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * #871: a charging limit lifted from 0 on a transaction whose EV stopped
 * asking for energy while the EVSE held it. 1.6 §4.9: "If charging is
 * suspended both by the EV and the EVSE, status SuspendedEVSE SHALL have
 * precedence over status SuspendedEV", so once the EVSE side lifts, the
 * connector reports SuspendedEV, not Charging; and the EV becoming ready
 * afterwards resumes Charging (§4.9 D3). Every path that lifts the limit is
 * covered: a schedule-period crossing and SetChargingProfile on 1.6 and 2.x.
 */

const statusAfter =
  (csms: MockCsms, index: number, status: string) => (frame: OcppFrame) =>
    csms.received.indexOf(frame) > index &&
    callOf("StatusNotification")(frame) &&
    (frame[3] as { status?: string }).status === status;

const chargingStateAfter =
  (csms: MockCsms, index: number, state: string) => (frame: OcppFrame) =>
    csms.received.indexOf(frame) > index &&
    callOf("TransactionEvent")(frame) &&
    (frame[3] as { transactionInfo?: { chargingState?: string } })
      .transactionInfo?.chargingState === state;

async function sendCall(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
): Promise<OcppFrame> {
  csms.send([2, messageId, action, payload]);
  return csms.waitForFrame(answerTo(messageId));
}

function profileV16(
  periods: Array<{ startPeriod: number; limit: number }>,
  startSchedule?: string,
) {
  return {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 871,
      stackLevel: 0,
      chargingProfilePurpose: "TxDefaultProfile",
      chargingProfileKind: startSchedule ? "Absolute" : "Relative",
      chargingSchedule: {
        ...(startSchedule && { startSchedule }),
        chargingRateUnit: "W",
        chargingSchedulePeriod: periods,
      },
    },
  };
}

function profileV201(limit: number) {
  return {
    evseId: 1,
    chargingProfile: {
      id: 871,
      stackLevel: 0,
      chargingProfilePurpose: "TxDefaultProfile",
      chargingProfileKind: "Relative",
      chargingSchedule: [
        {
          id: 871,
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit }],
        },
      ],
    },
  };
}

/** A booted 1.6 station charging on connector 1. */
async function chargingV16(csms: MockCsms, id: string) {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  const stop = answerEverythingElse(csms, ["StartTransaction"]);
  cp.evPlugIn(1);
  cp.startTransaction("TAG-871", 1);
  const start = await csms.waitForCall("StartTransaction");
  csms.replyCallResult(start.messageId, {
    transactionId: 8710,
    idTagInfo: { status: "Accepted" },
  });
  await csms.waitForFrame(statusAfter(csms, -1, "Charging"));
  return { cp, stop };
}

/** Steps 3-5 shared by the 1.6 cases: the EV stops asking while the EVSE
 *  holds it, the limit lifts, then the EV asks again. */
async function expectSuspendedEvThenCharging(
  cp: ChargePoint,
  csms: MockCsms,
  lift: () => Promise<void>,
) {
  const paused = csms.received.findIndex(
    statusAfter(csms, -1, "SuspendedEVSE"),
  );
  cp.evSetReady(1, false);
  await lift();
  await csms.waitForFrame(statusAfter(csms, paused, "SuspendedEV"));
  expect(
    csms.received.filter(statusAfter(csms, paused, "Charging")),
  ).toHaveLength(0);
  expect(cp.getConnector(1)!.status).toBe(OCPPStatus.SuspendedEV);
  const lifted = csms.received.length - 1;
  cp.evSetReady(1, true);
  await csms.waitForFrame(statusAfter(csms, lifted, "Charging"));
  expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Charging);
}

describe("limit 0 lifted on a not-ready EV, OCPP 1.6 (#871)", () => {
  it("a schedule period crossing to a non-zero limit reports SuspendedEV", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await chargingV16(csms, "CP16-871-CROSS");
    try {
      const connector = cp.getConnector(1)!;
      const startSchedule = new Date().toISOString();
      const set = await sendCall(
        csms,
        "set-cross",
        "SetChargingProfile",
        profileV16(
          [
            { startPeriod: 0, limit: 0 },
            { startPeriod: 2, limit: 11_000 },
          ],
          startSchedule,
        ),
      );
      expect(set[2]).toEqual({ status: "Accepted" });
      // The limit=0 period is crossed by the schedule, not by the handler.
      connector.announceScheduleCrossingNow();
      await csms.waitForFrame(statusAfter(csms, -1, "SuspendedEVSE"));
      await expectSuspendedEvThenCharging(cp, csms, async () => {
        const wait = Date.parse(startSchedule) + 2_100 - Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 0)));
        connector.announceScheduleCrossingNow();
      });
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("SetChargingProfile with a non-zero limit reports SuspendedEV", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await chargingV16(csms, "CP16-871-SET");
    try {
      const paused = await sendCall(
        csms,
        "set-zero",
        "SetChargingProfile",
        profileV16([{ startPeriod: 0, limit: 0 }]),
      );
      expect(paused[2]).toEqual({ status: "Accepted" });
      await csms.waitForFrame(statusAfter(csms, -1, "SuspendedEVSE"));
      await expectSuspendedEvThenCharging(cp, csms, async () => {
        const lifted = await sendCall(
          csms,
          "set-lift",
          "SetChargingProfile",
          profileV16([{ startPeriod: 0, limit: 11_000 }]),
        );
        expect(lifted[2]).toEqual({ status: "Accepted" });
      });
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);
});

describe("limit 0 lifted on a not-ready EV, OCPP 2.0.1 (#871)", () => {
  // The Set lift reaches the schedule-crossing listener first (the handler
  // resolves the limit, which announces the crossing); the Clear lift leaves
  // no profile, so nothing is announced and the handler itself resumes.
  it.each([
    [
      "SetChargingProfile with a non-zero limit",
      "SetChargingProfile",
      profileV201(11_000),
    ],
    [
      "ClearChargingProfile",
      "ClearChargingProfile",
      { chargingProfileId: 871 },
    ],
  ])(
    "%s reports chargingState SuspendedEV",
    async (_, action, payload) => {
      const csms = startMockCsms({ answerCalls: true });
      const cp = await bootedChargePoint(
        csms,
        `CP201-871-${action}`,
        "OCPP-2.0.1",
      );
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      try {
        cp.evPlugIn(1);
        cp.startTransaction("TAG-871", 1);
        await csms.waitForFrame(chargingStateAfter(csms, -1, "Charging"));
        // A local 2.x start leaves the connector Preparing; the operator moves
        // it to Charging as v201Transaction.bun.test.ts does.
        cp.updateConnectorStatus(1, OCPPStatus.Charging);
        const paused = await sendCall(
          csms,
          "set-zero",
          "SetChargingProfile",
          profileV201(0),
        );
        expect(paused[2]).toEqual({ status: "Accepted" });
        const suspended = csms.received.indexOf(
          await csms.waitForFrame(
            chargingStateAfter(csms, -1, "SuspendedEVSE"),
          ),
        );
        cp.evSetReady(1, false);
        const lifted = await sendCall(csms, "lift", action, payload);
        expect(lifted[2]).toEqual({ status: "Accepted" });
        await csms.waitForFrame(
          chargingStateAfter(csms, suspended, "SuspendedEV"),
        );
        expect(
          csms.received.filter(chargingStateAfter(csms, suspended, "Charging")),
        ).toHaveLength(0);
        expect(cp.getConnector(1)!.status).toBe(OCPPStatus.SuspendedEV);
        const before = csms.received.length - 1;
        cp.evSetReady(1, true);
        await csms.waitForFrame(chargingStateAfter(csms, before, "Charging"));
        expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Charging);
      } finally {
        cp.dispose();
        csms.stop();
      }
    },
    15000,
  );
});
