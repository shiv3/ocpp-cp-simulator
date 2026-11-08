import { describe, expect, it } from "bun:test";
import { startMockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ActiveChargingProfile } from "../../../domain/connector/Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
} from "../../../domain/types/OcppTypes";

// #799: a reconnect without BootNotification (OCPP-J 2.0.1 §5.4, #702) gives
// the CSMS no cue to push its limits again, so the station-level charging
// profiles must survive the link loss.

function stationMax(validTo?: string): ActiveChargingProfile {
  return {
    chargingProfileId: 799,
    connectorId: 0,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
    chargingProfileKind: ChargingProfileKindType.Absolute,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 11000 }],
    ...(validTo ? { validTo } : {}),
  };
}

async function dropAndReconnect(
  csms: ReturnType<typeof startMockCsms>,
  cp: ChargePoint,
): Promise<void> {
  const closed = new Promise((resolve) =>
    cp.events.once("disconnected", resolve),
  );
  csms.closeCurrentConnection(1011);
  await closed;
  const deadline = Date.now() + 10_000;
  while (!cp.isOnline()) {
    if (Date.now() > deadline) throw new Error("not reconnected in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s station charging profiles across a link loss (#799)",
  (version) => {
    it("a resumed link keeps ChargingStationMaxProfile capping", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, "CP799", version);
      const stopAnswering = answerEverythingElse(csms, []);
      try {
        cp.applyChargingProfile(stationMax(), "SetChargingProfile");
        expect(cp.getActiveChargePointMaxProfile()?.chargingProfileId).toBe(
          799,
        );

        await dropAndReconnect(csms, cp);

        expect(csms.received.filter(callOf("BootNotification"))).toHaveLength(
          1,
        );
        expect(cp.getActiveChargePointMaxProfile()?.chargingProfileId).toBe(
          799,
        );
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    }, 20_000);

    it("a profile that expired during the outage is not restored", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, "CP799-EXP", version);
      const stopAnswering = answerEverythingElse(csms, []);
      try {
        cp.applyChargingProfile(
          stationMax(new Date(Date.now() + 300).toISOString()),
          "SetChargingProfile",
        );
        const closed = new Promise((resolve) =>
          cp.events.once("disconnected", resolve),
        );
        csms.closeCurrentConnection(1011);
        await closed;
        await new Promise((resolve) => setTimeout(resolve, 400));
        const deadline = Date.now() + 10_000;
        while (!cp.isOnline() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(cp.stationProfiles.all()).toEqual([]);
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    }, 20_000);
  },
);
