import { describe, expect, it } from "vitest";
import { createChargePoint } from "../../../charge-point/createChargePoint";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  DefaultBootNotification,
} from "../../../../domain/types/OcppTypes";
import type { V201InboundContext } from "../inboundRegistryV201";
import { handleGetChargingProfilesV201 } from "../smartChargingV201";

function station(version: "OCPP-2.0.1" | "OCPP-2.1", evses = 3) {
  const chargePoint = createChargePoint(
    "CP-GET-PROFILES",
    DefaultBootNotification,
    evses,
    "ws://stub",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  const sent: { action: string; payload: Record<string, unknown> }[] = [];
  const ctx = {
    chargePoint,
    logger: chargePoint.logger,
    sendCall: (action: string, payload: Record<string, unknown>) =>
      void sent.push({ action, payload }),
  } as unknown as V201InboundContext;
  const install = (evseId: number, id: number) =>
    chargePoint.applyChargingProfile(
      {
        chargingProfileId: id,
        connectorId: evseId,
        stackLevel: id,
        chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
        chargingProfileKind: ChargingProfileKindType.Absolute,
        chargingRateUnit: ChargingRateUnitType.W,
        chargingSchedulePeriods: [{ startPeriod: 0, limit: 7000 }],
      },
      "SetChargingProfile",
    );
  const get = (evseId?: number) => {
    sent.length = 0;
    const result = handleGetChargingProfilesV201(
      {
        requestId: 42,
        ...(evseId === undefined ? {} : { evseId }),
        chargingProfile: {},
      },
      ctx,
    );
    result.afterResult?.();
    return { response: result.response, reports: [...sent] };
  };
  return { install, get };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s GetChargingProfiles",
  (version) => {
    it("scopes an EVSE query to that EVSE's own profiles (K09.FR.04)", () => {
      const { install, get } = station(version);
      install(0, 1);
      install(2, 2);
      const { response, reports } = get(2);
      expect(response).toEqual({ status: "Accepted" });
      expect(reports).toHaveLength(1);
      expect(reports[0].payload).toMatchObject({ requestId: 42, evseId: 2 });
      expect(reports[0].payload).not.toHaveProperty("tbc");
      expect(
        (reports[0].payload.chargingProfile as { id: number }[]).map(
          (p) => p.id,
        ),
      ).toEqual([2]);
    });

    it("answers NoProfiles for an EVSE that has none of its own", () => {
      const { install, get } = station(version);
      install(0, 1);
      expect(get(1).response).toEqual({ status: "NoProfiles" });
    });

    it("reports only station-level profiles for evseId 0 (K09.FR.05)", () => {
      const { install, get } = station(version);
      install(0, 1);
      install(2, 2);
      const { reports } = get(0);
      expect(reports).toHaveLength(1);
      expect(reports[0].payload).toMatchObject({ evseId: 0 });
    });

    it.each([1, 2, 3])(
      "sets tbc on every report but the last when profiles span %i EVSE(s) (K09.FR.02)",
      (count) => {
        const { install, get } = station(version);
        for (let evse = 1; evse <= count; evse += 1) install(evse, evse);
        const { reports } = get();
        expect(reports.map((r) => r.action)).toEqual(
          Array(count).fill("ReportChargingProfiles"),
        );
        expect(reports.map((r) => r.payload.requestId)).toEqual(
          Array(count).fill(42),
        );
        expect(reports.map((r) => r.payload.tbc)).toEqual([
          ...Array(count - 1).fill(true),
          undefined,
        ]);
      },
    );

    it("counts the station-level group as a report", () => {
      const { install, get } = station(version);
      install(0, 1);
      install(2, 2);
      const { reports } = get();
      expect(reports.map((r) => [r.payload.evseId, r.payload.tbc])).toEqual([
        [0, true],
        [2, undefined],
      ]);
    });
  },
);
