import { describe, expect, it } from "vitest";

import type { SampledValue } from "../../../../domain/connector/MeterValueBuilder";
import type { Transaction } from "../../../../domain/connector/Transaction";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import {
  OCPP12_WIRE_PROFILE,
  OCPP15_WIRE_PROFILE,
  OCPP16_WIRE_PROFILE,
} from "../soapWireProfiles";

const TIMESTAMP = new Date("2026-01-02T03:04:05.000Z");

const FULL_STATUS_OPTS = {
  errorCode: "EVCommunicationError" as const,
  info: "info",
  timestamp: TIMESTAMP,
  vendorId: "vendor",
  vendorErrorCode: "E42",
};

function transaction(reservationId?: number): Transaction {
  return {
    tagId: "TAG",
    startTime: TIMESTAMP,
    meterStart: 100,
    ...(reservationId !== undefined ? { reservationId } : {}),
  } as unknown as Transaction;
}

const ENERGY: SampledValue = {
  value: "1500",
  measurand: "Energy.Active.Import.Register",
  unit: "Wh",
  context: "Sample.Periodic",
};

describe("OCPP 1.2 wire profile", () => {
  it("sends exactly connectorId, status and errorCode on StatusNotification", () => {
    const payload = OCPP12_WIRE_PROFILE.toStatusNotificationRequest(
      1,
      OCPPStatus.Preparing,
      FULL_STATUS_OPTS,
    );
    expect(Object.keys(payload)).toEqual([
      "connectorId",
      "status",
      "errorCode",
    ]);
    expect(payload).toEqual({
      connectorId: 1,
      status: "Occupied",
      errorCode: "Mode3Error",
    });
  });

  it("sends the Energy.Active.Import.Register value, else 0, without transactionId", () => {
    const withEnergy = OCPP12_WIRE_PROFILE.toMeterValuesRequest(
      1,
      7,
      [{ value: "3", measurand: "Current.Import" }, ENERGY],
      TIMESTAMP,
    );
    expect(withEnergy).toStrictEqual({
      connectorId: 1,
      values: [{ timestamp: TIMESTAMP.toISOString(), value: "1500" }],
    });
    const withoutEnergy = OCPP12_WIRE_PROFILE.toMeterValuesRequest(
      1,
      7,
      [{ value: "3", measurand: "Current.Import" }],
      TIMESTAMP,
    );
    expect(withoutEnergy).toStrictEqual({
      connectorId: 1,
      values: [{ timestamp: TIMESTAMP.toISOString(), value: "0" }],
    });
  });

  it("sends no reservationId on StartTransaction", () => {
    const payload = OCPP12_WIRE_PROFILE.toStartTransactionRequest(
      transaction(9),
      2,
    );
    expect(Object.keys(payload)).toEqual([
      "connectorId",
      "idTag",
      "timestamp",
      "meterStart",
    ]);
  });
});

describe("OCPP 1.5 wire profile", () => {
  it("keeps the statusNotificationRequest XSD sequence", () => {
    const payload = OCPP15_WIRE_PROFILE.toStatusNotificationRequest(
      1,
      OCPPStatus.Preparing,
      FULL_STATUS_OPTS,
    );
    expect(Object.keys(payload)).toEqual([
      "connectorId",
      "status",
      "errorCode",
      "info",
      "timestamp",
      "vendorId",
      "vendorErrorCode",
    ]);
    expect(payload.status).toBe("Occupied");
    expect(payload.timestamp).toBe(TIMESTAMP.toISOString());
  });

  it("returns null when every sample is one 1.5 cannot express", () => {
    expect(
      OCPP15_WIRE_PROFILE.toMeterValuesRequest(
        1,
        7,
        [
          { value: "11000", measurand: "Power.Offered" },
          { value: "16", measurand: "Current.Offered" },
        ],
        TIMESTAMP,
      ),
    ).toBeNull();
  });

  it("puts the samples 1.5 can express under values[].value", () => {
    expect(
      OCPP15_WIRE_PROFILE.toMeterValuesRequest(
        1,
        7,
        [ENERGY, { value: "16", measurand: "Current.Offered" }],
        TIMESTAMP,
      ),
    ).toStrictEqual({
      connectorId: 1,
      transactionId: 7,
      values: [
        {
          timestamp: TIMESTAMP.toISOString(),
          value: [
            {
              "#text": "1500",
              "@_context": "Sample.Periodic",
              "@_measurand": "Energy.Active.Import.Register",
              "@_unit": "Wh",
            },
          ],
        },
      ],
    });
  });

  it("sends reservationId on StartTransaction when the transaction has one", () => {
    expect(
      Object.keys(
        OCPP15_WIRE_PROFILE.toStartTransactionRequest(transaction(9), 2),
      ),
    ).toEqual([
      "connectorId",
      "idTag",
      "timestamp",
      "meterStart",
      "reservationId",
    ]);
    expect(
      Object.keys(
        OCPP15_WIRE_PROFILE.toStartTransactionRequest(transaction(), 2),
      ),
    ).toEqual(["connectorId", "idTag", "timestamp", "meterStart"]);
  });
});

describe("OCPP 1.6 SOAP wire profile", () => {
  it("passes 1.6 statuses and error codes through", () => {
    const payload = OCPP16_WIRE_PROFILE.toStatusNotificationRequest(
      1,
      OCPPStatus.Preparing,
      FULL_STATUS_OPTS,
    );
    expect(payload.status).toBe("Preparing");
    expect(payload.errorCode).toBe("EVCommunicationError");
    expect(Object.keys(payload)).toEqual([
      "connectorId",
      "status",
      "errorCode",
      "info",
      "timestamp",
      "vendorId",
      "vendorErrorCode",
    ]);
  });

  it("nests sampledValue under meterValue and keeps per-phase samples", () => {
    expect(
      OCPP16_WIRE_PROFILE.toMeterValuesRequest(
        1,
        undefined,
        [{ value: "16", measurand: "Current.Import", phase: "L1" }],
        TIMESTAMP,
      ),
    ).toStrictEqual({
      connectorId: 1,
      meterValue: [
        {
          timestamp: TIMESTAMP.toISOString(),
          sampledValue: [
            { value: "16", measurand: "Current.Import", phase: "L1" },
          ],
        },
      ],
    });
  });

  it("sends reservationId on StartTransaction when the transaction has one", () => {
    expect(
      OCPP16_WIRE_PROFILE.toStartTransactionRequest(transaction(9), 2),
    ).toStrictEqual({
      connectorId: 2,
      idTag: "TAG",
      timestamp: TIMESTAMP.toISOString(),
      meterStart: 100,
      reservationId: 9,
    });
  });
});
