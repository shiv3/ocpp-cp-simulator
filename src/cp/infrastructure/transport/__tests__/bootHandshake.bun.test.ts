import { describe, it, expect } from "bun:test";
import { startMockCsms, normalizeTranscript } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

describe("OCPP 1.6 boot handshake (golden)", () => {
  it("boots, accepts, then reports connector-0 availability", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint("CP001", DefaultBootNotification, 1, csms.url, null, null);
    try {
      cp.connect();

      const boot = await csms.waitForCall("BootNotification");
      expect(csms.received[0][2]).toBe("BootNotification");
      expect(boot.payload).toMatchObject({
        chargePointVendor: "Vendor",
        chargePointModel: "Model",
      });

      csms.replyCallResult(boot.messageId, {
        currentTime: new Date(0).toISOString(),
        interval: 300,
        status: "Accepted",
      });

      // Accepting boot triggers a post-boot StatusNotification for connector 0.
      const status = await csms.waitForFrame(
        (f) =>
          f[0] === 2 &&
          f[2] === "StatusNotification" &&
          (f[3] as { connectorId?: number }).connectorId === 0,
      );
      expect((status[3] as { status?: string }).status).toBe("Available");

      // Freeze the full normalized transcript as a golden snapshot.
      expect(normalizeTranscript(csms.received)).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
