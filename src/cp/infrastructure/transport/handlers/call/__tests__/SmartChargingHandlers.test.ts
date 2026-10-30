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

  // A stack is restated on the joint phase count, as metering caps it: an
  // ampere limit is per phase, and delivery happens only on the phases every
  // profile permits.
  it("restates a mixed stack on the joint phase count, as metering caps it", () => {
    // Joint count 1: 10 A on 1 phase is 2300 W, under the 3000 W station cap.
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
      { startPeriod: 0, limit: 2300, numberPhases: 1 },
    ]);
    expect(compositeFor(profiles, "A").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10, numberPhases: 1 },
    ]);
  });

  it("restates a 16 A / 1-phase tx under a 10 A station cap as 10 A on 1 phase", () => {
    const profiles = {
      tx: {
        unit: "A" as const,
        periods: [{ startPeriod: 0, limit: 16, numberPhases: 1 }],
      },
      max: { unit: "A" as const, periods: [{ startPeriod: 0, limit: 10 }] },
    };
    expect(compositeFor(profiles, "A").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10, numberPhases: 1 },
    ]);
    expect(compositeFor(profiles, "W").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 2300, numberPhases: 1 },
    ]);
  });

  it("follows a tx phase restriction that ends over time under a station cap", () => {
    const profiles = {
      tx: {
        unit: "A" as const,
        periods: [
          { startPeriod: 0, limit: 16, numberPhases: 1 },
          { startPeriod: 600, limit: 16 },
        ],
      },
      max: { unit: "A" as const, periods: [{ startPeriod: 0, limit: 10 }] },
    };
    expect(compositeFor(profiles, "A").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 10, numberPhases: 1 },
      { startPeriod: 600, limit: 10 },
    ]);
  });

  it("restates a 1000 W tx under a 6 A / 1-phase station cap on 1 phase", () => {
    const profiles = {
      tx: { unit: "W" as const, periods: [{ startPeriod: 0, limit: 1000 }] },
      max: {
        unit: "A" as const,
        periods: [{ startPeriod: 0, limit: 6, numberPhases: 1 }],
      },
    };
    expect(compositeFor(profiles, "W").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 1000, numberPhases: 1 },
    ]);
    const amps = compositeFor(profiles, "A").chargingSchedulePeriod;
    expect(amps).toHaveLength(1);
    expect(amps[0].numberPhases).toBe(1);
    // 1000 / 230 = 4.347… A, floored to the schema's 0.1 step (#524).
    expect(amps[0].limit).toBe(4.3);
  });

  // GetCompositeScheduleResponse.json puts `multipleOf: 0.1` on `limit`: a
  // converted limit is floored to one decimal, never above the profiles.
  it("floors a 3000 W / 1-phase station cap asked in A to 13.0 A (#524)", () => {
    const profiles = {
      max: {
        unit: "W" as const,
        periods: [{ startPeriod: 0, limit: 3000, numberPhases: 1 }],
      },
    };
    expect(compositeFor(profiles, "A").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 13, numberPhases: 1 },
    ]);
  });

  it("floors a 6.123 A / 1-phase tx asked in W, keeps it verbatim in A (#524)", () => {
    const profiles = {
      tx: {
        unit: "A" as const,
        periods: [{ startPeriod: 0, limit: 6.123, numberPhases: 1 }],
      },
    };
    // 6.123 A × 230 V = 1408.29 W.
    expect(compositeFor(profiles, "W").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 1408.2, numberPhases: 1 },
    ]);
    expect(compositeFor(profiles, "A").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 6.123, numberPhases: 1 },
    ]);
  });

  it("does not floor float noise: 4.1 A / 1-phase asked in W is 943 W (#524)", () => {
    // 4.1 × 230 is 942.9999999999999 in binary floating point.
    const profiles = {
      tx: {
        unit: "A" as const,
        periods: [{ startPeriod: 0, limit: 4.1, numberPhases: 1 }],
      },
    };
    expect(compositeFor(profiles, "W").chargingSchedulePeriod).toStrictEqual([
      { startPeriod: 0, limit: 943, numberPhases: 1 },
    ]);
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
