import { describe, expect, it } from "vitest";
import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../../domain/connector/Transaction";
import { DefaultBootNotification } from "../../../../domain/types/OcppTypes";
import type { V201InboundContext } from "../inboundRegistryV201";
import { handleSetChargingProfileV201 } from "../smartChargingV201";

const TX = "tx-uuid-1";

function station(version: "OCPP-2.0.1" | "OCPP-2.1") {
  const chargePoint = new ChargePoint(
    "CP-SET-PROFILE",
    DefaultBootNotification,
    2,
    "ws://stub",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  const ctx = {
    chargePoint,
    logger: chargePoint.logger,
    sendCall: () => undefined,
  } as V201InboundContext;
  const startTransaction = (connectorId: number) => {
    const transaction: Transaction = {
      id: 7,
      cpTransactionId: TX,
      connectorId,
      tagId: "TAG",
      meterStart: 0,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    };
    chargePoint.getConnector(connectorId)!.beginTransaction(transaction);
  };
  const set = (
    evseId: number,
    profile: {
      id: number;
      stackLevel?: number;
      purpose: string;
      transactionId?: string;
    },
  ) =>
    handleSetChargingProfileV201(
      {
        evseId,
        chargingProfile: {
          id: profile.id,
          stackLevel: profile.stackLevel ?? 0,
          chargingProfilePurpose: profile.purpose,
          chargingProfileKind: "Absolute",
          ...(profile.transactionId === undefined
            ? {}
            : { transactionId: profile.transactionId }),
          chargingSchedule: [
            {
              id: profile.id,
              chargingRateUnit: "W",
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
            },
          ],
        },
      },
      ctx,
    ).response;
  return { chargePoint, startTransaction, set };
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s SetChargingProfile preconditions",
  (version) => {
    it("rejects a TxProfile on an EVSE with no transaction (K01.FR.09)", () => {
      const { chargePoint, set } = station(version);
      expect(
        set(1, { id: 1, purpose: "TxProfile", transactionId: TX }),
      ).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
      expect(chargePoint.getConnector(1)!.chargingProfiles).toEqual([]);
    });

    it("rejects a TxProfile whose transactionId is not the EVSE's transaction (K01.FR.33)", () => {
      const { chargePoint, startTransaction, set } = station(version);
      startTransaction(1);
      expect(
        set(1, { id: 1, purpose: "TxProfile", transactionId: "other" }),
      ).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
      expect(chargePoint.getConnector(1)!.chargingProfiles).toEqual([]);
    });

    it("rejects a TxProfile naming the transaction of another EVSE", () => {
      const { startTransaction, set } = station(version);
      startTransaction(2);
      expect(
        set(1, { id: 1, purpose: "TxProfile", transactionId: TX }),
      ).toMatchObject({ status: "Rejected" });
    });

    it("accepts a TxProfile for the running transaction (K01.FR.04)", () => {
      const { chargePoint, startTransaction, set } = station(version);
      startTransaction(1);
      expect(
        set(1, { id: 1, purpose: "TxProfile", transactionId: TX }),
      ).toEqual({ status: "Accepted" });
      expect(chargePoint.getConnector(1)!.chargingProfiles).toHaveLength(1);
    });

    it("rejects an EVSE 0 TxDefaultProfile that duplicates a stack level on an EVSE (K01.FR.52)", () => {
      const { chargePoint, set } = station(version);
      expect(
        set(1, { id: 1, stackLevel: 3, purpose: "TxDefaultProfile" }),
      ).toEqual({ status: "Accepted" });
      expect(
        set(0, { id: 2, stackLevel: 3, purpose: "TxDefaultProfile" }),
      ).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "DuplicateProfile" },
      });
      expect(chargePoint.stationProfiles.all()).toEqual([]);
    });

    it("rejects an EVSE TxDefaultProfile that duplicates a stack level on EVSE 0 (K01.FR.53)", () => {
      const { chargePoint, set } = station(version);
      expect(
        set(0, { id: 2, stackLevel: 3, purpose: "TxDefaultProfile" }),
      ).toEqual({ status: "Accepted" });
      expect(
        set(1, { id: 1, stackLevel: 3, purpose: "TxDefaultProfile" }),
      ).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "DuplicateProfile" },
      });
      expect(chargePoint.getConnector(1)!.chargingProfiles).toEqual([]);
    });

    it("accepts the same id (K01.FR.05) and another stack level", () => {
      const { set } = station(version);
      set(1, { id: 1, stackLevel: 3, purpose: "TxDefaultProfile" });
      expect(
        set(0, { id: 1, stackLevel: 3, purpose: "TxDefaultProfile" }),
      ).toEqual({ status: "Accepted" });
      expect(
        set(0, { id: 5, stackLevel: 4, purpose: "TxDefaultProfile" }),
      ).toEqual({ status: "Accepted" });
    });
  },
);
