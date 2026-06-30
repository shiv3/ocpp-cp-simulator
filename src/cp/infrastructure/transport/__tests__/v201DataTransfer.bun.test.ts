import { describe, expect, it } from "bun:test";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { outgoingV201Warning } from "../codec/validateV201";
import { startMockCsms } from "./mockCsms";

describe("OCPP 2.0.1 CP-initiated DataTransfer", () => {
  it("sends a DataTransfer CALL with vendor id, message id, and string data", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201-DATA-TRANSFER",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      await csms.waitForCall("StatusNotification");

      cp.sendDataTransfer("E2E", "scenario", "plain-string-data");

      const dataTransfer = await csms.waitForCall("DataTransfer");
      expect(dataTransfer.payload).toEqual({
        vendorId: "E2E",
        messageId: "scenario",
        data: "plain-string-data",
      });
      expect(outgoingV201Warning("DataTransfer", dataTransfer.payload)).toBe(
        null,
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
