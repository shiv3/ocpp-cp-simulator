import { describe, it, expect } from "bun:test";
import {
  answerTo,
  bootedV201ChargePoint,
  startMockCsms,
  type MockCsms,
} from "./mockCsms";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type {
  ChargePointEvents,
  IncomingCallCompletion,
} from "../../../domain/charge-point/ChargePointEvents";

/**
 * #396: on OCPP 2.0.1 every inbound CSMS CALL is announced as it enters
 * dispatch and again once its answer is decided, under the action name the
 * CSMS put on the wire.
 */
async function waitUntil(predicate: () => boolean, ms = 1_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function record(cp: ChargePoint) {
  const received: Array<ChargePointEvents["incomingCallReceived"]> = [];
  const completed: IncomingCallCompletion[] = [];
  cp.events.on("incomingCallReceived", (data) => received.push(data));
  cp.events.on("incomingCallCompleted", (data) => completed.push(data));
  return { received, completed };
}

async function withChargePoint(
  id: string,
  body: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = await bootedV201ChargePoint(csms, id);
  try {
    await body(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

describe("OCPP 2.0.1 inbound CSMS CALL events (#396)", () => {
  it("announces a Reset and completes it before the CALLRESULT leaves", async () => {
    await withChargePoint("CP201-396-RESET", async (csms, cp) => {
      const seen = record(cp);
      csms.send([2, "reset-1", "Reset", { type: "OnIdle" }]);
      const answer = await csms.waitForFrame(answerTo("reset-1"));

      expect(answer[0]).toBe(3);
      expect(seen.received).toEqual([
        { action: "Reset", messageId: "reset-1", payload: { type: "OnIdle" } },
      ]);
      expect(seen.completed).toEqual([
        { action: "Reset", messageId: "reset-1", outcome: "CallResult" },
      ]);
    });
  });

  it("reports RequestStartTransaction under its 2.0.1 name", async () => {
    await withChargePoint("CP201-396-START", async (csms, cp) => {
      const seen = record(cp);
      csms.send([
        2,
        "rs-1",
        "RequestStartTransaction",
        {
          idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
          remoteStartId: 1,
          evseId: 1,
        },
      ]);
      const answer = await csms.waitForFrame(answerTo("rs-1"));

      expect((answer[2] as { status: string }).status).toBe("Accepted");
      expect(seen.received.map((r) => [r.action, r.messageId])).toEqual([
        ["RequestStartTransaction", "rs-1"],
      ]);
      expect(seen.completed).toEqual([
        {
          action: "RequestStartTransaction",
          messageId: "rs-1",
          outcome: "CallResult",
        },
      ]);
    });
  });

  it("reports the CALLERROR code of an invalid or unsupported CALL", async () => {
    await withChargePoint("CP201-396-ERRORS", async (csms, cp) => {
      const seen = record(cp);
      csms.send([2, "bad-1", "Reset", {}]);
      expect((await csms.waitForFrame(answerTo("bad-1")))[2]).toBe(
        "FormationViolation",
      );
      csms.send([2, "unk-1", "NoSuchAction", {}]);
      expect((await csms.waitForFrame(answerTo("unk-1")))[2]).toBe(
        "NotImplemented",
      );

      expect(seen.completed).toEqual([
        {
          action: "Reset",
          messageId: "bad-1",
          outcome: "CallError",
          errorCode: "FormationViolation",
        },
        {
          action: "NoSuchAction",
          messageId: "unk-1",
          outcome: "CallError",
          errorCode: "NotImplemented",
        },
      ]);
    });
  });

  it("reports NoResponse when a handler throws, which leaves the CALL unanswered", async () => {
    await withChargePoint("CP201-396-THROW", async (csms, cp) => {
      const seen = record(cp);
      Object.defineProperty(cp, "connectors", {
        configurable: true,
        get: () => {
          throw new Error("boom");
        },
      });
      try {
        csms.send([
          2,
          "ca-1",
          "ChangeAvailability",
          { operationalStatus: "Inoperative" },
        ]);
        await waitUntil(() => seen.completed.length === 1);
      } finally {
        delete (cp as { connectors?: unknown }).connectors;
      }

      expect(seen.completed).toEqual([
        {
          action: "ChangeAvailability",
          messageId: "ca-1",
          outcome: "NoResponse",
        },
      ]);
      expect(csms.received.some((frame) => answerTo("ca-1")(frame))).toBe(
        false,
      );
    });
  });

  it("reports what an inbound policy or a response override answered", async () => {
    await withChargePoint("CP201-396-POLICY", async (csms, cp) => {
      const seen = record(cp);
      cp.setInboundCallPolicy("ClearCache", {
        kind: "callerror",
        errorCode: "NotSupported",
        errorDescription: "policy under test",
      });
      csms.send([2, "cc-1", "ClearCache", {}]);
      await csms.waitForFrame(answerTo("cc-1"));

      cp.setInboundCallPolicy("ClearCache", { kind: "ignore" });
      csms.send([2, "cc-2", "ClearCache", {}]);
      await waitUntil(() => seen.completed.length === 2);

      cp.clearInboundCallPolicy("ClearCache");
      cp.armResponseOverride("ClearCache", "Rejected");
      csms.send([2, "cc-3", "ClearCache", {}]);
      expect((await csms.waitForFrame(answerTo("cc-3")))[2]).toEqual({
        status: "Rejected",
      });

      expect(seen.completed).toEqual([
        {
          action: "ClearCache",
          messageId: "cc-1",
          outcome: "CallError",
          errorCode: "NotSupported",
        },
        { action: "ClearCache", messageId: "cc-2", outcome: "NoResponse" },
        { action: "ClearCache", messageId: "cc-3", outcome: "CallResult" },
      ]);
    });
  });
});
