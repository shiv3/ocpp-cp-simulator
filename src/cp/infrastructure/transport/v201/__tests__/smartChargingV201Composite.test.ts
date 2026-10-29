import { describe, expect, it } from "vitest";
import type { GetCompositeScheduleResponseV201 } from "../../../../../ocpp";
import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { ChargingSchedulePeriod } from "../../../../domain/connector/Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  DefaultBootNotification,
} from "../../../../domain/types/OcppTypes";
import type { V201InboundContext } from "../inboundRegistryV201";
import { handleGetCompositeScheduleV201 } from "../smartChargingV201";

/**
 * The 2.0.1 / 2.1 composite shares the 1.6 rule: a profile period comes
 * back verbatim in its own unit with its `numberPhases`, and the other
 * unit converts at 230 V on that period's phase count (#323).
 */
function compositeFor(
  unit: ChargingRateUnitType,
  periods: ChargingSchedulePeriod[],
  chargingRateUnit?: "A" | "W",
): GetCompositeScheduleResponseV201 {
  const chargePoint = new ChargePoint(
    "CP201-COMPOSITE",
    DefaultBootNotification,
    1,
    "ws://stub",
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
    {},
  );
  chargePoint.getConnector(1)!.setChargingProfiles([
    {
      chargingProfileId: 1,
      connectorId: 1,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
      chargingProfileKind: ChargingProfileKindType.Relative,
      chargingRateUnit: unit,
      chargingSchedulePeriods: periods,
    },
  ]);
  const ctx = {
    chargePoint,
    logger: chargePoint.logger,
    sendCall: () => undefined,
  } as V201InboundContext;
  return handleGetCompositeScheduleV201(
    { evseId: 1, duration: 3600, chargingRateUnit },
    ctx,
  ).response as GetCompositeScheduleResponseV201;
}

describe("handleGetCompositeScheduleV201 round trip (#323)", () => {
  it("returns a 6 A / 1-phase profile as 6 A with numberPhases 1", () => {
    const res = compositeFor(
      ChargingRateUnitType.A,
      [{ startPeriod: 0, limit: 6, numberPhases: 1 }],
      "A",
    );
    expect(res.schedule?.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6, numberPhases: 1 },
    ]);
  });

  it("converts a W profile to A on its own numberPhases", () => {
    const res = compositeFor(
      ChargingRateUnitType.W,
      [{ startPeriod: 0, limit: 1380, numberPhases: 1 }],
      "A",
    );
    expect(res.schedule?.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6, numberPhases: 1 },
    ]);
  });

  it("defaults to W and converts an A profile on its own numberPhases", () => {
    const res = compositeFor(ChargingRateUnitType.A, [
      { startPeriod: 0, limit: 6, numberPhases: 1 },
    ]);
    expect(res.schedule?.chargingRateUnit).toBe("W");
    expect(res.schedule?.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 1380, numberPhases: 1 },
    ]);
  });

  it("keeps two periods apart when equal watts come from different phase counts", () => {
    const res = compositeFor(
      ChargingRateUnitType.A,
      [
        { startPeriod: 0, limit: 6, numberPhases: 3 },
        { startPeriod: 1800, limit: 18, numberPhases: 1 },
      ],
      "A",
    );
    expect(res.schedule?.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6, numberPhases: 3 },
      { startPeriod: 1800, limit: 18, numberPhases: 1 },
    ]);
  });

  it("converts over 3 phases and emits no numberPhases when the period has none", () => {
    const res = compositeFor(
      ChargingRateUnitType.W,
      [{ startPeriod: 0, limit: 6900 }],
      "A",
    );
    expect(res.schedule?.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10 },
    ]);
  });
});
