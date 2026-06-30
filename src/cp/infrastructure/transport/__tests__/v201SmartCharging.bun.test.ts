import { describe, expect, it } from "bun:test";
import type {
  GetCompositeScheduleResponseV201,
  ReportChargingProfilesRequestV201,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function reportChargingProfilesFrames(csms: MockCsms): OcppFrame[] {
  return csms.received.filter(
    (frame) => frame[0] === 2 && frame[2] === "ReportChargingProfiles",
  );
}

async function expectNoAdditionalReportChargingProfiles(
  csms: MockCsms,
  baseline: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reportChargingProfilesFrames(csms)).toHaveLength(baseline);
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
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId === 1,
  );
}

async function sendCall(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
): Promise<OcppFrame> {
  csms.send([2, messageId, action, payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

function txDefaultProfile(id: number): Record<string, unknown> {
  return {
    id,
    stackLevel: 0,
    chargingProfilePurpose: "TxDefaultProfile",
    chargingProfileKind: "Absolute",
    chargingSchedule: [
      {
        id,
        chargingRateUnit: "W",
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }],
      },
    ],
  };
}

describe("OCPP 2.0.1 Smart Charging", () => {
  it("sets, reports, composites, and clears profiles via the shared v201 registry", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-SMART-CHARGING",
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
      await bootAccepted(csms);

      expect(
        await sendCall(csms, "scp-accepted", "SetChargingProfile", {
          evseId: 1,
          chargingProfile: txDefaultProfile(1),
        }),
      ).toEqual([3, "scp-accepted", { status: "Accepted" }]);

      expect(
        await sendCall(csms, "scp-rejected", "SetChargingProfile", {
          evseId: 1,
          chargingProfile: {
            ...txDefaultProfile(2),
            chargingProfilePurpose: "ChargingStationExternalConstraints",
          },
        }),
      ).toEqual([3, "scp-rejected", { status: "Rejected" }]);

      expect(
        await sendCall(csms, "gcp-accepted", "GetChargingProfiles", {
          requestId: 42,
          evseId: 1,
          chargingProfile: {},
        }),
      ).toEqual([3, "gcp-accepted", { status: "Accepted" }]);

      const report = await csms.waitForCall("ReportChargingProfiles");
      const reportPayload = report.payload as ReportChargingProfilesRequestV201;
      expect(reportPayload.requestId).toBe(42);
      expect(reportPayload.evseId).toBe(1);
      expect(reportPayload.chargingProfile.length).toBeGreaterThan(0);
      expect(reportPayload.chargingProfile[0].chargingSchedule[0].id).toBe(1);
      csms.replyCallResult(report.messageId, {});

      const compositeFrame = await sendCall(
        csms,
        "gcs-finite",
        "GetCompositeSchedule",
        { evseId: 1, duration: 3600 },
      );
      const composite = compositeFrame[2] as GetCompositeScheduleResponseV201;
      expect(composite.status).toBe("Accepted");
      expect(composite.schedule).toBeDefined();
      for (const period of composite.schedule?.chargingSchedulePeriod ?? []) {
        expect(Number.isFinite(period.limit)).toBe(true);
      }

      const reportCount = reportChargingProfilesFrames(csms).length;
      expect(
        await sendCall(csms, "gcp-ems", "GetChargingProfiles", {
          requestId: 43,
          evseId: 1,
          chargingProfile: { chargingLimitSource: ["EMS"] },
        }),
      ).toEqual([3, "gcp-ems", { status: "NoProfiles" }]);
      await expectNoAdditionalReportChargingProfiles(csms, reportCount);

      expect(
        await sendCall(csms, "ccp-accepted", "ClearChargingProfile", {
          chargingProfileId: 1,
        }),
      ).toEqual([3, "ccp-accepted", { status: "Accepted" }]);

      const reportCountAfterClear = reportChargingProfilesFrames(csms).length;
      expect(
        await sendCall(csms, "gcp-empty", "GetChargingProfiles", {
          requestId: 44,
          evseId: 1,
          chargingProfile: {},
        }),
      ).toEqual([3, "gcp-empty", { status: "NoProfiles" }]);
      await expectNoAdditionalReportChargingProfiles(
        csms,
        reportCountAfterClear,
      );

      expect(
        await sendCall(csms, "ccp-unknown", "ClearChargingProfile", {
          chargingProfileId: 999,
        }),
      ).toEqual([3, "ccp-unknown", { status: "Unknown" }]);

      const uncappedCompositeFrame = await sendCall(
        csms,
        "gcs-uncapped",
        "GetCompositeSchedule",
        { evseId: 1, duration: 3600 },
      );
      expect(uncappedCompositeFrame[2]).toEqual({ status: "Accepted" });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});

describe("OCPP 2.1 shared Smart Charging handler", () => {
  it("rejects v21-only Dynamic profiles at the shared mapper boundary", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP21-SMART-CHARGING",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();
      await bootAccepted(csms);

      expect(
        await sendCall(csms, "v21-dynamic", "SetChargingProfile", {
          evseId: 1,
          chargingProfile: {
            ...txDefaultProfile(21),
            chargingProfileKind: "Dynamic",
          },
        }),
      ).toEqual([3, "v21-dynamic", { status: "Rejected" }]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
