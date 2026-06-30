import { describe, it, expect } from "bun:test";
import { startMockCsms, normalizeTranscript } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

describe("OCPP 2.0.1 boot handshake", () => {
  it("boots, accepts, then reports station and connector availability", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP201",
      DefaultBootNotification,
      2,
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
      expect(csms.received[0][2]).toBe("BootNotification");
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
        (f) =>
          f[0] === 2 &&
          f[2] === "StatusNotification" &&
          (f[3] as { evseId?: number; connectorId?: number }).evseId === 0 &&
          (f[3] as { evseId?: number; connectorId?: number }).connectorId === 0,
      );
      expect(status0[3]).toMatchObject({
        evseId: 0,
        connectorId: 0,
        connectorStatus: "Available",
      });

      for (const evseId of [1, 2]) {
        const status = await csms.waitForFrame(
          (f) =>
            f[0] === 2 &&
            f[2] === "StatusNotification" &&
            (f[3] as { evseId?: number; connectorId?: number }).evseId ===
              evseId &&
            (f[3] as { evseId?: number; connectorId?: number }).connectorId ===
              1,
        );
        expect(status[3]).toMatchObject({
          evseId,
          connectorId: 1,
          connectorStatus: "Available",
        });
      }

      expect(normalizeTranscript(csms.received)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
