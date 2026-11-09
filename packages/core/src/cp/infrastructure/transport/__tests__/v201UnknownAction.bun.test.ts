import { describe, it, expect } from "bun:test";
import { startMockCsms, normalizeTranscript } from "./mockCsms";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

describe("OCPP 2.0.1 unknown action", () => {
  it("answers CALLERROR NotImplemented to an unsupported CSMS action", async () => {
    const csms = startMockCsms();
    const cp = createChargePoint(
      "CP201-UNKNOWN",
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
        currentTime: new Date(0).toISOString(),
        interval: 300,
      });

      csms.send([2, "err-201-1", "TotallyUnknownAction", {}]);

      const callError = await csms.waitForFrame(
        (f) => f[0] === 4 && f[1] === "err-201-1",
      );
      expect(callError).toEqual([
        4,
        "err-201-1",
        "NotImplemented",
        "This action is not supported",
        {},
      ]);
      expect(normalizeTranscript([callError])).toMatchSnapshot();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
