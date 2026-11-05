import { describe, it, expect } from "bun:test";
import { startMockCsms } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

describe("OCPP 2.1 boot handshake", () => {
  it("uses the v201-shaped boot and post-boot status frames", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP21",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.1",
      {},
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      expect(boot.payload).toMatchObject({
        reason: "PowerUp",
        chargingStation: {
          model: "Model",
          vendorName: "Vendor",
        },
      });

      csms.replyCallResult(boot.messageId, {
        status: "Accepted",
        currentTime: "2026-06-24T00:00:00.000Z",
        interval: 300,
      });

      const status0 = await csms.waitForFrame(
        (frame) =>
          frame[0] === 2 &&
          frame[2] === "StatusNotification" &&
          (frame[3] as { evseId?: number; connectorId?: number }).evseId ===
            0 &&
          (frame[3] as { evseId?: number; connectorId?: number })
            .connectorId === 0,
      );
      expect(status0[3]).toMatchObject({
        evseId: 0,
        connectorId: 0,
        connectorStatus: "Available",
      });
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
