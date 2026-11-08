import { describe, it, expect } from "vitest";
import {
  ClearChargingProfileHandler,
  GetCompositeScheduleHandler,
  SetChargingProfileHandler,
} from "../SmartChargingHandlers";
import { HandlerCallError } from "../../HandlerCallError";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { createChargePoint } from "../../../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";

/**
 * #594: OCPP 1.6 SetChargingProfile replacement by id or by stackLevel +
 * purpose, the TxProfile preconditions, and NotSupported without the
 * SmartCharging feature profile.
 */
function setup() {
  const chargePoint = createChargePoint(
    "CP-SCP-594",
    DefaultBootNotification,
    2,
    "ws://stub",
    null,
    null,
  );
  const ctx = { chargePoint, logger: chargePoint.logger } as HandlerContext;
  const handler = new SetChargingProfileHandler();
  const startTransaction = (connectorId: number, id: number) =>
    chargePoint.getConnector(connectorId)!.beginTransaction({
      id,
      connectorId,
      tagId: "TAG",
      meterStart: 0,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    });
  const profile = (
    id: number,
    purpose: string,
    stackLevel: number,
    extra: Record<string, unknown> = {},
    limit = 6000,
  ) => ({
    chargingProfileId: id,
    stackLevel,
    chargingProfilePurpose: purpose,
    chargingProfileKind: "Absolute",
    chargingSchedule: {
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit }],
    },
    ...extra,
  });
  const set = (connectorId: number, p: ReturnType<typeof profile>) =>
    handler.handle({ connectorId, csChargingProfiles: p } as never, ctx) as {
      status: string;
    };
  const ids = (connectorId: number) =>
    chargePoint
      .getConnector(connectorId)!
      .chargingProfiles.map((p) => p.chargingProfileId)
      .sort();
  return { chargePoint, ctx, set, profile, startTransaction, ids };
}

describe("SetChargingProfile replacement (#594)", () => {
  it("replaces the profile with the same chargingProfileId", () => {
    const { set, profile, ids } = setup();
    expect(set(1, profile(1, "TxDefaultProfile", 1)).status).toBe("Accepted");
    expect(set(1, profile(1, "TxDefaultProfile", 2)).status).toBe("Accepted");
    expect(ids(1)).toEqual([1]);
  });

  it("replaces the profile with the same stackLevel and purpose under another id", () => {
    const { set, profile, ids, chargePoint } = setup();
    set(1, profile(1, "TxDefaultProfile", 3, {}, 6000));
    expect(set(1, profile(2, "TxDefaultProfile", 3, {}, 3000)).status).toBe(
      "Accepted",
    );
    expect(ids(1)).toEqual([2]);
    expect(
      chargePoint.getConnector(1)!.chargingProfiles[0].chargingSchedulePeriods,
    ).toEqual([{ startPeriod: 0, limit: 3000 }]);
  });

  it("keeps profiles that differ in stackLevel or purpose", () => {
    const { set, profile, ids } = setup();
    set(1, profile(1, "TxDefaultProfile", 3));
    set(1, profile(2, "TxDefaultProfile", 4));
    set(1, profile(3, "ChargePointMaxProfile", 3)); // other scope: rejected
    expect(ids(1)).toEqual([1, 2]);
  });

  it("does not replace across connectors", () => {
    const { set, profile, ids } = setup();
    set(1, profile(1, "TxDefaultProfile", 3));
    set(2, profile(2, "TxDefaultProfile", 3));
    expect(ids(1)).toEqual([1]);
    expect(ids(2)).toEqual([2]);
  });

  it("replaces by slot in the station store", () => {
    const { set, profile, chargePoint } = setup();
    set(0, profile(10, "ChargePointMaxProfile", 0));
    expect(set(0, profile(11, "ChargePointMaxProfile", 0)).status).toBe(
      "Accepted",
    );
    expect(
      chargePoint.stationProfiles.all().map((p) => p.chargingProfileId),
    ).toEqual([11]);
  });
});

describe("SetChargingProfile replacement is visible on the timeline (#594)", () => {
  it("names the displaced profile instead of calling the new one an update", () => {
    const { chargePoint, set, profile } = setup();
    set(1, profile(1, "TxDefaultProfile", 3));
    set(1, profile(2, "TxDefaultProfile", 3));
    set(1, profile(2, "TxDefaultProfile", 3));
    const applied = chargePoint.timeline.query({
      kinds: ["charging_profile_applied"],
    }).entries;
    expect(applied).toHaveLength(3);
    // First install: nothing replaced.
    expect(applied[0].data.replaced).toBe(false);
    expect(applied[0].data.replacedIds).toBeUndefined();
    // Slot replacement: a new profile, so not "updated", and 1 is named.
    expect(applied[1].data.replaced).toBe(false);
    expect(applied[1].data.replacedIds).toEqual([1]);
    expect(applied[1].summary).toContain("applied");
    expect(applied[1].summary).toContain("replacing profile 1");
    // Same id again: a true update.
    expect(applied[2].data.replaced).toBe(true);
    expect(applied[2].data.replacedIds).toBeUndefined();
    expect(applied[2].summary).toContain("updated");
  });
});

describe("SetChargingProfile TxProfile preconditions (#594)", () => {
  it("rejects a TxProfile when the attached transaction is already closed", () => {
    const { chargePoint, set, profile, startTransaction, ids } = setup();
    startTransaction(1, 42);
    chargePoint.getConnector(1)!.transaction!.stopTime = new Date();
    expect(chargePoint.getConnector(1)!.hasRunningTransaction).toBe(false);
    expect(set(1, profile(1, "TxProfile", 0)).status).toBe("Rejected");
    expect(ids(1)).toEqual([]);
  });

  it("rejects a TxProfile for a connector without an active transaction", () => {
    const { set, profile, ids } = setup();
    expect(set(1, profile(1, "TxProfile", 0)).status).toBe("Rejected");
    expect(ids(1)).toEqual([]);
  });

  it("accepts a TxProfile for the active transaction, with or without transactionId", () => {
    const { set, profile, startTransaction, ids } = setup();
    startTransaction(1, 42);
    expect(set(1, profile(1, "TxProfile", 0)).status).toBe("Accepted");
    expect(
      set(1, profile(2, "TxProfile", 1, { transactionId: 42 })).status,
    ).toBe("Accepted");
    expect(ids(1)).toEqual([1, 2]);
  });

  it("rejects a TxProfile whose transactionId is not the active transaction", () => {
    const { set, profile, startTransaction, ids } = setup();
    startTransaction(1, 42);
    expect(
      set(1, profile(1, "TxProfile", 0, { transactionId: 7 })).status,
    ).toBe("Rejected");
    expect(ids(1)).toEqual([]);
  });

  it("does not use another connector's transaction", () => {
    const { set, profile, startTransaction } = setup();
    startTransaction(2, 42);
    expect(
      set(1, profile(1, "TxProfile", 0, { transactionId: 42 })).status,
    ).toBe("Rejected");
  });

  it("does not require a transaction for TxDefaultProfile", () => {
    const { set, profile } = setup();
    expect(set(1, profile(1, "TxDefaultProfile", 0)).status).toBe("Accepted");
  });
});

describe("SetChargingProfile without SmartCharging (#594)", () => {
  it("answers NotSupported as a CALLERROR when SmartCharging is not advertised", () => {
    const { chargePoint, set, profile, ids } = setup();
    chargePoint.configuration.setRuntimeValue("SupportedFeatureProfiles", [
      "Core",
    ]);
    let thrown: unknown;
    try {
      set(1, profile(1, "TxDefaultProfile", 0));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HandlerCallError);
    expect((thrown as HandlerCallError).errorCode).toBe("NotSupported");
    expect(ids(1)).toEqual([]);
  });

  it("answers NotSupported to ClearChargingProfile and GetCompositeSchedule too", () => {
    const { chargePoint, set, profile, ctx, ids } = setup();
    set(1, profile(1, "TxDefaultProfile", 0));
    chargePoint.configuration.setRuntimeValue("SupportedFeatureProfiles", [
      "Core",
    ]);
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as HandlerCallError).errorCode;
      }
      return undefined;
    };
    expect(
      code(() => new ClearChargingProfileHandler().handle({} as never, ctx)),
    ).toBe("NotSupported");
    expect(
      code(() =>
        new GetCompositeScheduleHandler().handle(
          { connectorId: 1, duration: 600 } as never,
          ctx,
        ),
      ),
    ).toBe("NotSupported");
    // Nothing was cleared.
    expect(ids(1)).toEqual([1]);
  });
});
