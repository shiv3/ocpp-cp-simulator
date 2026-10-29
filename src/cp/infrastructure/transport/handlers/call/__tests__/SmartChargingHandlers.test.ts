import { describe, it, expect, beforeEach } from "vitest";
import {
  SetChargingProfileHandler,
  ClearChargingProfileHandler,
  GetCompositeScheduleHandler,
} from "../SmartChargingHandlers";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import {
  ChargingProfilePurposeType,
  DefaultBootNotification,
} from "../../../../../domain/types/OcppTypes";

/**
 * A HandlerContext over a real, unconnected ChargePoint: the handlers route
 * through `applyChargingProfile` / `clearChargingProfiles`, which also feed
 * the operational timeline (#469).
 */
function buildContext(opts: { connectorCount?: number } = {}) {
  const chargePoint = new ChargePoint(
    "CP-SMART-16",
    DefaultBootNotification,
    opts.connectorCount ?? 2,
    "ws://stub",
    null,
    null,
  );
  return {
    ctx: {
      chargePoint,
      logger: chargePoint.logger,
    } as HandlerContext,
    chargePoint,
    stationProfiles: chargePoint.stationProfiles,
    connectors: chargePoint.connectors,
  };
}

describe("SetChargingProfileHandler", () => {
  let handler: SetChargingProfileHandler;
  beforeEach(() => {
    handler = new SetChargingProfileHandler();
  });

  it("routes connectorId=0 ChargePointMaxProfile to station store (no per-connector duplication)", () => {
    const { ctx, stationProfiles, connectors } = buildContext();
    const res = handler.handle(
      {
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 100,
          stackLevel: 1,
          chargingProfilePurpose: "ChargePointMaxProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: {
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
          },
        },
      },
      ctx,
    );
    expect(res).toEqual({ status: "Accepted" });
    expect(stationProfiles.all()).toHaveLength(1);
    // Crucially: no duplication onto each connector.
    for (const c of connectors.values()) {
      expect(c.chargingProfiles).toEqual([]);
    }
  });

  it("rejects ChargePointMaxProfile on a non-zero connector", () => {
    const { ctx } = buildContext();
    const res = handler.handle(
      {
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: "ChargePointMaxProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: {
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
          },
        },
      },
      ctx,
    );
    expect(res).toEqual({ status: "Rejected" });
  });

  it("rejects TxProfile on connector 0", () => {
    const { ctx } = buildContext();
    const res = handler.handle(
      {
        connectorId: 0,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxProfile",
          chargingProfileKind: "Relative",
          chargingSchedule: {
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
          },
        },
      },
      ctx,
    );
    expect(res).toEqual({ status: "Rejected" });
  });

  it("stores a connector-scoped TxDefaultProfile on the connector", () => {
    const { ctx, connectors } = buildContext();
    handler.handle(
      {
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: 5,
          stackLevel: 0,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: "Relative",
          chargingSchedule: {
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 4000 }],
          },
        },
      },
      ctx,
    );
    expect(connectors.get(1)!.chargingProfiles).toHaveLength(1);
    expect(connectors.get(2)!.chargingProfiles).toHaveLength(0);
  });
});

describe("ClearChargingProfileHandler", () => {
  it("clears station profiles when connectorId is omitted", () => {
    const { ctx, chargePoint, stationProfiles } = buildContext();
    chargePoint.applyChargingProfile(
      {
        chargingProfileId: 9,
        connectorId: 0,
        stackLevel: 0,
        chargingProfilePurpose:
          ChargingProfilePurposeType.ChargePointMaxProfile,
        chargingProfileKind: "Absolute" as never,
        chargingRateUnit: "W" as never,
        chargingSchedulePeriods: [{ startPeriod: 0, limit: 1000 }],
      },
      "SetChargingProfile",
    );
    const res = new ClearChargingProfileHandler().handle({}, ctx);
    expect(res).toEqual({ status: "Accepted" });
    expect(stationProfiles.all()).toEqual([]);
  });

  it("Accepted even when no profiles matched (§5.4)", () => {
    const { ctx, chargePoint } = buildContext();
    const res = new ClearChargingProfileHandler().handle({ id: 999 }, ctx);
    expect(res).toEqual({ status: "Accepted" });
    expect(
      chargePoint.timeline.query({ kinds: ["charging_profile_cleared"] }).total,
    ).toBe(0);
  });
});

describe("1.6 smart charging on the operational timeline (#469)", () => {
  it("records a station-wide and a connector profile set, then cleared", () => {
    const { ctx, chargePoint } = buildContext();
    const set = (connectorId: number, id: number, purpose: string) =>
      new SetChargingProfileHandler().handle(
        {
          connectorId,
          csChargingProfiles: {
            chargingProfileId: id,
            stackLevel: 1,
            chargingProfilePurpose: purpose,
            chargingProfileKind: "Absolute",
            chargingSchedule: {
              chargingRateUnit: "W",
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 5000 }],
            },
          },
        } as never,
        ctx,
      );

    expect(set(0, 100, "ChargePointMaxProfile")).toEqual({
      status: "Accepted",
    });
    expect(set(2, 5, "TxDefaultProfile")).toEqual({ status: "Accepted" });
    new ClearChargingProfileHandler().handle({}, ctx);

    const entries = chargePoint.timeline.query({
      kinds: ["charging_profile_applied", "charging_profile_cleared"],
    }).entries;
    expect(
      entries.map((e) => [
        e.kind,
        e.connectorId,
        e.data.profileId ?? e.data.profiles,
        e.data.source ?? e.data.reason,
      ]),
    ).toEqual([
      ["charging_profile_applied", undefined, 100, "SetChargingProfile"],
      ["charging_profile_applied", 2, 5, "SetChargingProfile"],
      [
        "charging_profile_cleared",
        undefined,
        [{ profileId: 100, purpose: "ChargePointMaxProfile", stackLevel: 1 }],
        "ClearChargingProfile",
      ],
      [
        "charging_profile_cleared",
        2,
        [{ profileId: 5, purpose: "TxDefaultProfile", stackLevel: 1 }],
        "ClearChargingProfile",
      ],
    ]);
  });
});

describe("GetCompositeScheduleHandler", () => {
  it("returns an Accepted+empty composite when no profiles are active", () => {
    const { ctx } = buildContext();
    const res = new GetCompositeScheduleHandler().handle(
      { connectorId: 1, duration: 3600 },
      ctx,
    );
    expect(res.status).toBe("Accepted");
    // chargingSchedule is in the response shape when Accepted
    if (res.status === "Accepted") {
      expect(res.chargingSchedule?.chargingSchedulePeriod).toEqual([]);
    }
  });

  it("returns the min-merge of tx + station max", () => {
    const { ctx, chargePoint, connectors } = buildContext();
    // Connector 1 has a tx profile capped at 10kW for 30min then 8kW
    connectors.get(1)!.setChargingProfiles([
      {
        chargingProfileId: 1,
        connectorId: 1,
        stackLevel: 0,
        chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
        chargingProfileKind: "Relative" as never,
        chargingRateUnit: "W" as never,
        chargingSchedulePeriods: [
          { startPeriod: 0, limit: 10_000 },
          { startPeriod: 1800, limit: 8_000 },
        ],
      },
    ]);
    // Station-wide max capped at 5kW
    chargePoint.applyChargingProfile(
      {
        chargingProfileId: 99,
        connectorId: 0,
        stackLevel: 0,
        chargingProfilePurpose:
          ChargingProfilePurposeType.ChargePointMaxProfile,
        chargingProfileKind: "Absolute" as never,
        chargingRateUnit: "W" as never,
        chargingSchedulePeriods: [{ startPeriod: 0, limit: 5_000 }],
      },
      "SetChargingProfile",
    );

    const res = new GetCompositeScheduleHandler().handle(
      { connectorId: 1, duration: 3600 },
      ctx,
    );
    expect(res.status).toBe("Accepted");
    if (res.status === "Accepted") {
      // Min should be 5000 (station max) throughout; the inner shift at
      // 1800 doesn't surface because station cap is tighter.
      expect(res.chargingSchedule?.chargingSchedulePeriod).toEqual([
        { startPeriod: 0, limit: 5_000 },
      ]);
    }
  });
});

type TestPeriod = { startPeriod: number; limit: number; numberPhases?: number };

/**
 * A composite restates the CSMS's own profiles, so it must hand a profile's
 * limit back in that profile's unit unchanged and keep its `numberPhases`;
 * a request for the other unit converts on the 230 V reference and the
 * winning period's phase count (#323).
 */
describe("GetCompositeScheduleHandler round trip (#323)", () => {
  function compositeFor(
    profiles: {
      tx?: { unit: "A" | "W"; periods: TestPeriod[] };
      max?: { unit: "A" | "W"; periods: TestPeriod[] };
    },
    chargingRateUnit?: "A" | "W",
  ) {
    const { ctx, chargePoint, connectors } = buildContext();
    if (profiles.tx) {
      connectors.get(1)!.setChargingProfiles([
        {
          chargingProfileId: 1,
          connectorId: 1,
          stackLevel: 0,
          chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
          chargingProfileKind: "Relative" as never,
          chargingRateUnit: profiles.tx.unit as never,
          chargingSchedulePeriods: profiles.tx.periods,
        },
      ]);
    }
    if (profiles.max) {
      chargePoint.applyChargingProfile(
        {
          chargingProfileId: 99,
          connectorId: 0,
          stackLevel: 0,
          chargingProfilePurpose:
            ChargingProfilePurposeType.ChargePointMaxProfile,
          chargingProfileKind: "Absolute" as never,
          chargingRateUnit: profiles.max.unit as never,
          chargingSchedulePeriods: profiles.max.periods,
        },
        "SetChargingProfile",
      );
    }
    const res = new GetCompositeScheduleHandler().handle(
      { connectorId: 1, duration: 3600, chargingRateUnit },
      ctx,
    );
    if (res.status !== "Accepted") throw new Error("expected Accepted");
    return res.chargingSchedule!;
  }

  it.each([
    { unit: "A" as const, period: { limit: 6, numberPhases: 1 } },
    { unit: "A" as const, period: { limit: 6, numberPhases: 3 } },
    { unit: "A" as const, period: { limit: 6 } },
    { unit: "A" as const, period: { limit: 16.7, numberPhases: 1 } },
    { unit: "A" as const, period: { limit: 13.3, numberPhases: 2 } },
    { unit: "W" as const, period: { limit: 1380, numberPhases: 1 } },
    { unit: "W" as const, period: { limit: 7000.5 } },
  ])(
    "returns a $unit profile's limit $period.limit with numberPhases $period.numberPhases unchanged",
    ({ unit, period }) => {
      const schedule = compositeFor(
        { tx: { unit, periods: [{ startPeriod: 0, ...period }] } },
        unit,
      );
      expect(schedule.chargingRateUnit).toBe(unit);
      expect(schedule.chargingSchedulePeriod).toStrictEqual([
        { startPeriod: 0, ...period },
      ]);
    },
  );

  it("converts an A profile to W on its own numberPhases and keeps it", () => {
    const schedule = compositeFor(
      {
        tx: {
          unit: "A",
          periods: [{ startPeriod: 0, limit: 6, numberPhases: 1 }],
        },
      },
      "W",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 1380, numberPhases: 1 },
    ]);
  });

  it("converts a W profile to A on its own numberPhases and keeps it", () => {
    const schedule = compositeFor(
      {
        tx: {
          unit: "W",
          periods: [{ startPeriod: 0, limit: 1380, numberPhases: 1 }],
        },
      },
      "A",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6, numberPhases: 1 },
    ]);
  });

  it("converts on 3 phases and emits no numberPhases when the period has none", () => {
    const schedule = compositeFor(
      { tx: { unit: "W", periods: [{ startPeriod: 0, limit: 6900 }] } },
      "A",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10 },
    ]);
  });

  it("treats a numberPhases that is not a positive integer as no restriction", () => {
    const schedule = compositeFor(
      {
        tx: {
          unit: "W",
          periods: [{ startPeriod: 0, limit: 6900, numberPhases: 0 }],
        },
      },
      "A",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10 },
    ]);
  });

  it("restates a negative limit as 0, as the watts are clamped", () => {
    const schedule = compositeFor(
      { tx: { unit: "A", periods: [{ startPeriod: 0, limit: -5 }] } },
      "A",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 0 },
    ]);
  });

  it("defaults to W when the request names no unit", () => {
    const schedule = compositeFor({
      tx: {
        unit: "A",
        periods: [{ startPeriod: 0, limit: 6, numberPhases: 1 }],
      },
    });
    expect(schedule.chargingRateUnit).toBe("W");
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 1380, numberPhases: 1 },
    ]);
  });

  it("restates the winning profile of a mixed stack on that profile's phases", () => {
    // Each profile converts on its own numberPhases for the min: 10 A on
    // 3 phases is 6900 W, so the 3000 W / 1-phase station profile wins and
    // is restated as 3000 / 230 A on its one phase. (The live cap for the
    // same stack converts on the joint phase count instead — 2300 W.)
    const profiles = {
      tx: {
        unit: "A" as const,
        periods: [{ startPeriod: 0, limit: 10, numberPhases: 3 }],
      },
      max: {
        unit: "W" as const,
        periods: [{ startPeriod: 0, limit: 3000, numberPhases: 1 }],
      },
    };
    expect(compositeFor(profiles, "W").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 3000, numberPhases: 1 },
    ]);
    const amps = compositeFor(profiles, "A").chargingSchedulePeriod;
    expect(amps).toHaveLength(1);
    expect(amps[0].numberPhases).toBe(1);
    expect(amps[0].limit).toBeCloseTo(3000 / 230, 10);
  });

  it("keeps two periods apart when equal watts come from different phase counts", () => {
    // 6 A × 230 V × 3 = 18 A × 230 V × 1 = 4140 W.
    const schedule = compositeFor(
      {
        tx: {
          unit: "A",
          periods: [
            { startPeriod: 0, limit: 6, numberPhases: 3 },
            { startPeriod: 1800, limit: 18, numberPhases: 1 },
          ],
        },
      },
      "A",
    );
    expect(schedule.chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6, numberPhases: 3 },
      { startPeriod: 1800, limit: 18, numberPhases: 1 },
    ]);
  });
});
