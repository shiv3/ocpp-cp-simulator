import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * #349: on OCPP 2.0.1 the inbound CALL dispatch now consults what the 1.6
 * handler always did — the csmsCallTrigger event, inbound policies and
 * one-shot response overrides — and a scenario may spell the action in
 * either version's vocabulary.
 */
async function bootedChargePoint(
  csms: MockCsms,
  id: string,
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
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
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
  return cp;
}

const answerTo = (messageId: string) => (frame: OcppFrame) =>
  (frame[0] === 3 || frame[0] === 4) && frame[1] === messageId;

const REQUEST_START = {
  idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
  remoteStartId: 1,
  evseId: 1,
};

describe("OCPP 2.0.1 inbound policy / response override / csmsCallTrigger (#349)", () => {
  it("a responseOverride armed under the 1.6 name answers the 2.0.1 CALL once", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-OVERRIDE");
    try {
      cp.armResponseOverride("RemoteStartTransaction", "Rejected");
      csms.send([2, "rs-1", "RequestStartTransaction", REQUEST_START]);
      const first = await csms.waitForFrame(answerTo("rs-1"));
      expect(first[0]).toBe(3);
      expect(first[2]).toEqual({ status: "Rejected" });

      // One-shot: the next call reaches the real handler.
      csms.send([2, "rs-2", "RequestStartTransaction", REQUEST_START]);
      const second = await csms.waitForFrame(answerTo("rs-2"));
      expect(second[0]).toBe(3);
      expect((second[2] as { status: string }).status).toBe("Accepted");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("an inboundPolicy of kind callerror answers with the CALLERROR it names", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-POLICY-ERR");
    try {
      cp.setInboundCallPolicy("Reset", {
        kind: "callerror",
        errorCode: "NotSupported",
        errorDescription: "policy under test",
      });
      csms.send([2, "reset-1", "Reset", { type: "Immediate" }]);
      const answer = await csms.waitForFrame(answerTo("reset-1"));
      expect(answer[0]).toBe(4);
      expect(answer[2]).toBe("NotSupported");
      expect(answer[3]).toBe("policy under test");

      // Sticky: the second Reset gets the same refusal.
      csms.send([2, "reset-2", "Reset", { type: "Immediate" }]);
      expect((await csms.waitForFrame(answerTo("reset-2")))[0]).toBe(4);

      // Cleared: the handler answers again.
      cp.clearInboundCallPolicy("Reset");
      csms.send([2, "reset-3", "Reset", { type: "Immediate" }]);
      expect((await csms.waitForFrame(answerTo("reset-3")))[0]).toBe(3);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("an inboundPolicy of kind ignore answers nothing", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-POLICY-IGNORE");
    try {
      cp.setInboundCallPolicy("RequestStopTransaction", { kind: "ignore" });
      csms.send([
        2,
        "stop-1",
        "RequestStopTransaction",
        { transactionId: "t" },
      ]);
      await expect(
        csms.waitForFrame(answerTo("stop-1"), 300),
      ).rejects.toThrow();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("every incoming CALL is surfaced to the scenario layer under its wire name", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-TRIGGER");
    try {
      const seen: Array<{ action: string }> = [];
      cp.events.on("incomingCallReceived", (evt: { action: string }) =>
        seen.push(evt),
      );
      csms.send([2, "rs-1", "RequestStartTransaction", REQUEST_START]);
      await csms.waitForFrame(answerTo("rs-1"));
      expect(seen.map((e) => e.action)).toEqual(["RequestStartTransaction"]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
