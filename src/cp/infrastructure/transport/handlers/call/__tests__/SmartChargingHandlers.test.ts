import { describe, it, expect, beforeEach } from "vitest";
import {
  SetChargingProfileHandler,
  ClearChargingProfileHandler,
  GetCompositeScheduleHandler,
} from "../SmartChargingHandlers";
import { ChargingProfileStore } from "../../../../../domain/charge-point/ChargingProfileStore";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import {
  ChargingProfilePurposeType,
  OCPPStatus,
} from "../../../../../domain/types/OcppTypes";
import type { ActiveChargingProfile } from "../../../../../domain/connector/Connector";

/**
 * Construct a stand-in HandlerContext that exposes only the slice these
 * handlers consume:
 *   - chargePoint.stationProfiles  (real ChargingProfileStore)
 *   - chargePoint.connectors       (Map of stub connectors)
 *   - chargePoint.getConnector(id) (Map lookup)
 *   - chargePoint.updateConnectorStatus(id, status) (no-op)
 *   - chargePoint.getActiveChargePointMaxProfile()
 *
 * The stub connectors expose `addChargingProfile`, `removeChargingProfiles`,
 * `getActiveChargingProfile`, and the `id` / `status` / `transaction`
 * shape touched by `applyProfileStatus`.
 */
function buildContext(opts: { connectorIds?: number[] } = {}) {
  const stationProfiles = new ChargingProfileStore();
  const logger = new Logger();
  const ids = opts.connectorIds ?? [1, 2];

  const connectors = new Map<number, ConnectorStub>();
  for (const id of ids) {
    connectors.set(id, makeConnectorStub(id));
  }

  const chargePoint = {
    stationProfiles,
    connectors,
    getConnector: (id: number) => connectors.get(id),
    updateConnectorStatus: (_id: number, _status: OCPPStatus) => {
      // no-op: status transitions are not under test here
    },
    getActiveChargePointMaxProfile: (now?: Date) =>
      stationProfiles.getActive(
        ChargingProfilePurposeType.ChargePointMaxProfile,
        now,
      ),
    // ConfigurationStore stub for defaultConfiguration() in validate path
    wsUrl: "ws://stub",
    connectorNumber: ids.length,
  };

  return {
    ctx: {
      chargePoint: chargePoint as unknown as ChargePoint,
      logger,
    } as HandlerContext,
    stationProfiles,
    connectors,
  };
}

interface ConnectorStub {
  id: number;
  status: OCPPStatus;
  transaction: null;
  profiles: ActiveChargingProfile[];
  addChargingProfile(p: ActiveChargingProfile): void;
  removeChargingProfiles(criteria: {
    profileId?: number;
    purpose?: ChargingProfilePurposeType;
    stackLevel?: number;
  }): number;
  getActiveChargingProfile(): ActiveChargingProfile | null;
}

function makeConnectorStub(id: number): ConnectorStub {
  return {
    id,
    status: OCPPStatus.Available,
    transaction: null,
    profiles: [],
    addChargingProfile(p: ActiveChargingProfile) {
      this.profiles = this.profiles.filter(
        (x) => x.chargingProfileId !== p.chargingProfileId,
      );
      this.profiles.push(p);
    },
    removeChargingProfiles(criteria) {
      const before = this.profiles.length;
      this.profiles = this.profiles.filter((p) => {
        if (
          criteria.profileId != null &&
          p.chargingProfileId !== criteria.profileId
        )
          return true;
        if (
          criteria.purpose != null &&
          p.chargingProfilePurpose !== criteria.purpose
        )
          return true;
        if (criteria.stackLevel != null && p.stackLevel !== criteria.stackLevel)
          return true;
        return false;
      });
      return before - this.profiles.length;
    },
    getActiveChargingProfile() {
      return this.profiles[0] ?? null;
    },
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
      expect(c.profiles).toEqual([]);
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
    expect(connectors.get(1)!.profiles).toHaveLength(1);
    expect(connectors.get(2)!.profiles).toHaveLength(0);
  });
});

describe("ClearChargingProfileHandler", () => {
  it("clears station profiles when connectorId is omitted", () => {
    const { ctx, stationProfiles } = buildContext();
    stationProfiles.add({
      chargingProfileId: 9,
      connectorId: 0,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingProfileKind: "Absolute" as never,
      chargingRateUnit: "W" as never,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 1000 }],
    });
    const res = new ClearChargingProfileHandler().handle({}, ctx);
    expect(res).toEqual({ status: "Accepted" });
    expect(stationProfiles.all()).toEqual([]);
  });

  it("Accepted even when no profiles matched (§5.4)", () => {
    const { ctx } = buildContext();
    const res = new ClearChargingProfileHandler().handle({ id: 999 }, ctx);
    expect(res).toEqual({ status: "Accepted" });
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
    const { ctx, connectors, stationProfiles } = buildContext();
    // Connector 1 has a tx profile capped at 10kW for 30min then 8kW
    connectors.get(1)!.profiles = [
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
    ];
    // Station-wide max capped at 5kW
    stationProfiles.add({
      chargingProfileId: 99,
      connectorId: 0,
      stackLevel: 0,
      chargingProfilePurpose: ChargingProfilePurposeType.ChargePointMaxProfile,
      chargingProfileKind: "Absolute" as never,
      chargingRateUnit: "W" as never,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 5_000 }],
    });

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
