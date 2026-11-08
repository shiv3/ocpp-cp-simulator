import { describe, expect, it } from "vitest";
import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { resolveScheduleLimitWatts } from "../../../../domain/connector/ChargingScheduleResolver";
import { DefaultBootNotification } from "../../../../domain/types/OcppTypes";
import type { V201InboundContext } from "../inboundRegistryV201";
import {
  handleGetChargingProfilesV201,
  handleSetChargingProfileV201,
} from "../smartChargingV201";

const DAY = 86_400;

function station(version: "OCPP-2.0.1" | "OCPP-2.1") {
  const chargePoint = new ChargePoint(
    "CP-PROFILE-TIMES",
    DefaultBootNotification,
    1,
    "ws://stub",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  const reports: Record<string, unknown>[] = [];
  const ctx = {
    chargePoint,
    logger: chargePoint.logger,
    sendCall: (_action: string, payload: Record<string, unknown>) =>
      void reports.push(payload),
  } as unknown as V201InboundContext;
  const set = (
    times: { validFrom?: string; validTo?: string; startSchedule?: string },
    kind = "Absolute",
  ) =>
    handleSetChargingProfileV201(
      {
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: kind,
          ...(kind === "Recurring" && { recurrencyKind: "Daily" }),
          ...(times.validFrom && { validFrom: times.validFrom }),
          ...(times.validTo && { validTo: times.validTo }),
          chargingSchedule: [
            {
              id: 1,
              ...(times.startSchedule && {
                startSchedule: times.startSchedule,
              }),
              chargingRateUnit: "W",
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 2000 },
                { startPeriod: 8 * DAY, limit: 5000 },
                { startPeriod: 8 * DAY + 2 * 3600, limit: 9000 },
              ],
            },
          ],
        },
      },
      ctx,
    ).response;
  const report = () => {
    reports.length = 0;
    handleGetChargingProfilesV201(
      { requestId: 1, chargingProfile: {} },
      ctx,
    ).afterResult?.();
    return (reports[0].chargingProfile as Record<string, unknown>[])[0] as {
      validFrom?: string;
      validTo?: string;
      chargingSchedule: { startSchedule?: string }[];
    };
  };
  const limitAt = (iso: string) => {
    const now = new Date(iso);
    const connector = chargePoint.getConnector(1)!;
    return resolveScheduleLimitWatts(
      connector.getActiveChargingProfile(now),
      new Date("2026-11-09T00:30:00Z"),
      now,
    ).watts;
  };
  return { set, report, limitAt };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s validFrom / validTo / startSchedule (K01.FR.30, K01.FR.36, K01.FR.37)",
  (version) => {
    it("counts the periods from startSchedule, not from validFrom", () => {
      const { set, limitAt } = station(version);
      expect(
        set({
          validFrom: "2026-11-09T00:00:00Z",
          startSchedule: "2026-11-01T00:00:00Z",
        }),
      ).toEqual({ status: "Accepted" });
      // validFrom + 1 h is 8 d 1 h after startSchedule: the 5000 W period.
      expect(limitAt("2026-11-09T01:00:00Z")).toBe(5000);
      expect(limitAt("2026-11-09T02:30:00Z")).toBe(9000);
    });

    it("is active only inside [validFrom, validTo)", () => {
      const { set, limitAt } = station(version);
      set({
        validFrom: "2026-11-09T00:00:00Z",
        validTo: "2026-11-09T03:00:00Z",
        startSchedule: "2026-11-01T00:00:00Z",
      });
      expect(limitAt("2026-11-08T23:59:59Z")).toBe(Infinity);
      expect(limitAt("2026-11-09T00:00:00Z")).toBe(5000);
      expect(limitAt("2026-11-09T03:00:01Z")).toBe(Infinity);
    });

    it("reports back what was set and invents nothing", () => {
      const { set, report } = station(version);
      set({
        validFrom: "2026-11-09T00:00:00Z",
        validTo: "2026-11-10T00:00:00Z",
        startSchedule: "2026-11-01T00:00:00Z",
      });
      expect(report()).toMatchObject({
        validFrom: "2026-11-09T00:00:00Z",
        validTo: "2026-11-10T00:00:00Z",
        chargingSchedule: [{ startSchedule: "2026-11-01T00:00:00Z" }],
      });

      const second = station(version);
      second.set({ startSchedule: "2026-11-01T00:00:00Z" });
      const onlyStart = second.report();
      expect(onlyStart).not.toHaveProperty("validFrom");
      expect(onlyStart).not.toHaveProperty("validTo");

      const third = station(version);
      third.set({});
      const none = third.report();
      expect(none.chargingSchedule[0]).not.toHaveProperty("startSchedule");
      expect(none).not.toHaveProperty("validFrom");
    });

    it("does not impose a schedule before a future startSchedule (K01.FR.30)", () => {
      const { set, limitAt } = station(version);
      set({ startSchedule: "2026-11-10T00:00:00Z" });
      expect(limitAt("2026-11-09T12:00:00Z")).toBe(Infinity);
      expect(limitAt("2026-11-10T00:00:01Z")).toBe(2000);
    });
  },
);
