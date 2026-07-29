// src/cli/exportK6/__tests__/wire16.test.ts
import { describe, expect, it } from "vitest";
import { wire16 } from "../runtime/wire/v16";

const NOW = "2026-07-29T00:00:00.000Z";

describe("wire16", () => {
  it("declares the ocpp1.6 subprotocol", () => {
    expect(wire16.subprotocol).toBe("ocpp1.6");
  });

  it("builds BootNotification", () => {
    expect(wire16.bootNotification("CP-1")).toEqual({
      action: "BootNotification",
      payload: {
        chargePointVendor: "ocpp-cp-simulator",
        chargePointModel: "k6-loadtest",
        chargePointSerialNumber: "CP-1",
      },
    });
  });

  it("builds StatusNotification with defaults and extras", () => {
    expect(wire16.statusNotification(1, "Available")).toEqual({
      action: "StatusNotification",
      payload: { connectorId: 1, status: "Available", errorCode: "NoError" },
    });
    expect(
      wire16.statusNotification(2, "Faulted", {
        errorCode: "GroundFailure",
        info: "i",
        vendorErrorCode: "V1",
        vendorId: "acme",
      }).payload,
    ).toEqual({
      connectorId: 2,
      status: "Faulted",
      errorCode: "GroundFailure",
      info: "i",
      vendorErrorCode: "V1",
      vendorId: "acme",
    });
  });

  it("builds Start/StopTransaction and parses the conf", () => {
    expect(wire16.startTransaction(1, "TAG", 100, NOW)).toEqual({
      action: "StartTransaction",
      payload: {
        connectorId: 1,
        idTag: "TAG",
        meterStart: 100,
        timestamp: NOW,
      },
    });
    expect(
      wire16.parseStartTransactionConf({
        transactionId: 7,
        idTagInfo: { status: "Accepted" },
      }),
    ).toEqual({ transactionId: 7, accepted: true });
    expect(
      wire16.parseStartTransactionConf({ idTagInfo: { status: "Blocked" } }),
    ).toEqual({ transactionId: null, accepted: false });
    expect(wire16.stopTransaction(7, 500, NOW, "Remote")).toEqual({
      action: "StopTransaction",
      payload: {
        transactionId: 7,
        meterStop: 500,
        timestamp: NOW,
        reason: "Remote",
      },
    });
    expect(wire16.stopTransaction(7, 500, NOW).payload).not.toHaveProperty(
      "reason",
    );
  });

  it("builds MeterValues with and without a transaction", () => {
    const withTx = wire16.meterValues(1, 7, 1234, NOW);
    expect(withTx.action).toBe("MeterValues");
    expect(withTx.payload).toEqual({
      connectorId: 1,
      transactionId: 7,
      meterValue: [
        {
          timestamp: NOW,
          sampledValue: [
            {
              value: "1234",
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
            },
          ],
        },
      ],
    });
    expect(wire16.meterValues(1, null, 1, NOW).payload).not.toHaveProperty(
      "transactionId",
    );
  });

  it("builds DataTransfer omitting blank optionals", () => {
    expect(wire16.dataTransfer("acme", "msg", "d").payload).toEqual({
      vendorId: "acme",
      messageId: "msg",
      data: "d",
    });
    expect(wire16.dataTransfer("acme").payload).toEqual({ vendorId: "acme" });
  });

  it("maps trigger kinds to 1.6 action names", () => {
    expect(wire16.triggerActions("remoteStart")).toEqual([
      "RemoteStartTransaction",
    ]);
    expect(wire16.triggerActions("remoteStop")).toEqual([
      "RemoteStopTransaction",
    ]);
    expect(wire16.triggerActions("reserveNow")).toEqual(["ReserveNow"]);
  });

  it("extracts the remote-start idTag", () => {
    expect(wire16.remoteStartTagId({ idTag: "T1" })).toBe("T1");
    expect(wire16.remoteStartTagId({})).toBeNull();
  });
});
