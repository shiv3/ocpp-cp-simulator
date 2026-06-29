import { describe, it, expect } from "bun:test";
import { startMockCsms, normalizeTranscript } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

describe("OCPP 1.6 unknown action (golden)", () => {
  it("answers CALLERROR NotImplemented to an unknown CSMS action", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint("CP002", DefaultBootNotification, 1, csms.url, null, null);
    try {
      cp.connect();
      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date(0).toISOString(),
        interval: 300,
        status: "Accepted",
      });

      csms.send([2, "err-1", "TotallyUnknownAction", {}]);

      const callError = await csms.waitForFrame((f) => f[0] === 4 && f[1] === "err-1");
      // Full CALLERROR frame: [4, messageId, errorCode, errorDescription, errorDetails].
      expect(callError[0]).toBe(4);
      expect(callError[2]).toBe("NotImplemented");
      expect(callError.length).toBe(5);
      // Freeze the full normalized CALLERROR frame as a golden snapshot.
      expect(normalizeTranscript([callError])).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
