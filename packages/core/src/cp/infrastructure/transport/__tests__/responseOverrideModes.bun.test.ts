import { describe, it, expect } from "bun:test";
import { answerTo, bootedV201ChargePoint, startMockCsms } from "./mockCsms";

/**
 * #1090: a response override can make the station answer a CSMS CALL with a
 * CALLERROR of the test's choosing, an arbitrary CALLRESULT or raw frame, a
 * CALLRESULTERROR, a late answer or none, and `times` / `persistent` repeat
 * it. Wire level, on OCPP 2.1 (the 2.0.1 path is the same gate).
 */
const RESET = { type: "Immediate" };

async function station() {
  const csms = startMockCsms();
  const cp = await bootedV201ChargePoint(csms, "CP21-RESP", "OCPP-2.1");
  return {
    csms,
    cp,
    stop: async () => {
      cp.disconnect();
      await csms.stop();
    },
  };
}

describe("response override modes on the wire (#1090)", () => {
  it("callError: the code, description and details reach the CSMS", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({
        action: "Reset",
        mode: "callError",
        errorCode: "SecurityError",
        errorDescription: "denied",
        errorDetails: { reason: "test" },
      });
      csms.send([2, "r-1", "Reset", RESET]);
      expect(await csms.waitForFrame(answerTo("r-1"))).toEqual([
        4,
        "r-1",
        "SecurityError",
        "denied",
        { reason: "test" },
      ]);
      // One-shot: the next Reset reaches the engine.
      csms.send([2, "r-2", "Reset", RESET]);
      expect((await csms.waitForFrame(answerTo("r-2")))[0]).toBe(3);
    } finally {
      await stop();
    }
  });

  it("callResult: a schema-invalid payload is written as given", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({
        action: "Reset",
        mode: "callResult",
        payload: { status: "Bogus", extra: [1] },
      });
      csms.send([2, "r-1", "Reset", RESET]);
      expect(await csms.waitForFrame(answerTo("r-1"))).toEqual([
        3,
        "r-1",
        { status: "Bogus", extra: [1] },
      ]);
    } finally {
      await stop();
    }
  });

  it("raw: a 4-element CALLERROR frame goes out verbatim", async () => {
    const { csms, cp, stop } = await station();
    try {
      const frame = JSON.stringify([4, "r-1", "InternalError", "short"]);
      cp.setResponseOverride({ action: "Reset", mode: "raw", frame });
      csms.send([2, "r-1", "Reset", RESET]);
      expect(await csms.waitForFrame(answerTo("r-1"))).toEqual([
        4,
        "r-1",
        "InternalError",
        "short",
      ]);
    } finally {
      await stop();
    }
  });

  it("callResultError: a type 5 frame carries the CALL's id", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({
        action: "Reset",
        mode: "callResultError",
        errorCode: "FormatViolation",
        errorDescription: "no",
      });
      csms.send([2, "r-1", "Reset", RESET]);
      const frame = await csms.waitForFrame((f) => f[0] === 5);
      expect(frame).toEqual([5, "r-1", "FormatViolation", "no", {}]);
    } finally {
      await stop();
    }
  });

  it("delay: the engine's own answer arrives late", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({ action: "Reset", mode: "delay", delayMs: 400 });
      const start = Date.now();
      csms.send([2, "r-1", "Reset", RESET]);
      const answer = await csms.waitForFrame(answerTo("r-1"));
      expect(Date.now() - start).toBeGreaterThanOrEqual(350);
      expect(answer[0]).toBe(3);
      expect(answer[2]).toEqual({ status: "Accepted" });
    } finally {
      await stop();
    }
  });

  it("noAnswer with times 2: two CALLs are left unanswered, the third is answered", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({ action: "Reset", mode: "noAnswer", times: 2 });
      for (const id of ["r-1", "r-2"]) {
        csms.send([2, id, "Reset", RESET]);
        await expect(csms.waitForFrame(answerTo(id), 250)).rejects.toThrow();
      }
      csms.send([2, "r-3", "Reset", RESET]);
      expect((await csms.waitForFrame(answerTo("r-3")))[0]).toBe(3);
    } finally {
      await stop();
    }
  });

  it("persistent holds until cleared, and clear reports how many it dropped", async () => {
    const { csms, cp, stop } = await station();
    try {
      cp.setResponseOverride({
        action: "Reset",
        mode: "callError",
        errorCode: "NotSupported",
        persistent: true,
      });
      for (const id of ["r-1", "r-2", "r-3"]) {
        csms.send([2, id, "Reset", RESET]);
        expect((await csms.waitForFrame(answerTo(id)))[0]).toBe(4);
      }
      expect(cp.clearResponseOverrides("Reset")).toBe(1);
      expect(cp.clearResponseOverrides()).toBe(0);
      csms.send([2, "r-4", "Reset", RESET]);
      expect((await csms.waitForFrame(answerTo("r-4")))[0]).toBe(3);
    } finally {
      await stop();
    }
  });

  it("refuses a mode without the field it needs", async () => {
    const { cp, stop } = await station();
    try {
      expect(() =>
        cp.setResponseOverride({ action: "Reset", mode: "callError" }),
      ).toThrow(/errorCode/);
      expect(() =>
        cp.setResponseOverride({ action: "Reset", mode: "delay" }),
      ).toThrow(/delayMs/);
      expect(() =>
        cp.setResponseOverride({ action: "Reset", mode: "raw" }),
      ).toThrow(/frame/);
      expect(() =>
        cp.setResponseOverride({ action: "Reset", times: 0, status: "x" }),
      ).toThrow(/times/);
    } finally {
      await stop();
    }
  });

  it("sendCallResultError writes a type 5 frame, on a 2.1 station only", async () => {
    const { csms, cp, stop } = await station();
    try {
      const sent = await cp.sendCallResultError({
        messageId: "m-9",
        errorCode: "FormatViolation",
        errorDescription: "bad response",
        errorDetails: { path: "status" },
      });
      expect(sent.messageId).toBe("m-9");
      expect(await csms.waitForFrame((f) => f[0] === 5)).toEqual([
        5,
        "m-9",
        "FormatViolation",
        "bad response",
        { path: "status" },
      ]);
    } finally {
      await stop();
    }
    const csms2 = startMockCsms();
    const cp2 = await bootedV201ChargePoint(csms2, "CP201-NO5");
    try {
      await expect(
        cp2.sendCallResultError({ messageId: "m-1" }),
      ).rejects.toThrow(/2\.1/);
    } finally {
      cp2.disconnect();
      await csms2.stop();
    }
  });
});
