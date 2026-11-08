import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { callOf, callsOf, stationFor } from "./stationHarness";
import type { TransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/index";

// OCPP-J 2.0.1 / 2.1 Part 4 §4.1.1 (#708): the station sends the next CALL
// only after the CALLRESULT / CALLERROR of the previous one or its
// MessageTimeout.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls = (csms: MockCsms) => csms.received.filter((f) => f[0] === 2);
// `csms.received` holds what the station sent, not the replies: the
// unanswered CALLs are those the test has not replied to (Boot is replied).
const answered = new Set<string>();
const reply = (csms: MockCsms, id: string, payload: unknown = {}) => {
  answered.add(id);
  csms.replyCallResult(id, payload);
};
const unanswered = (csms: MockCsms) =>
  calls(csms).filter(
    (c) => c[2] !== "BootNotification" && !answered.has(c[1] as string),
  );

async function boot(csms: MockCsms, version: string, messageTimeout?: number) {
  const cp = stationFor(csms, "CP708", version, { connectors: 2 });
  // Before connect: the first StatusNotification arms the slot timer at once.
  if (messageTimeout !== undefined) {
    cp.configuration.setRuntimeValue("MessageTimeout", messageTimeout);
  }
  cp.connect();
  const bootCall = await csms.waitForCall("BootNotification");
  csms.replyCallResult(bootCall.messageId, {
    status: "Accepted",
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  return cp;
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s one CALL in flight",
  (version) => {
    it("sends the next CALL after the answer", async () => {
      const csms = startMockCsms({ answerStatusNotifications: false });
      const cp = await boot(csms, version);
      try {
        await csms.waitForFrame(callOf("StatusNotification"));
        await wait(300);
        // Boot answered; the first StatusNotification is unanswered, so the
        // other two (EVSE 0, EVSE 1, EVSE 2) have not gone out.
        expect(unanswered(csms).map((c) => c[2])).toEqual([
          "StatusNotification",
        ]);
        expect(callsOf(csms, "StatusNotification")).toHaveLength(1);

        const first = unanswered(csms)[0]!;
        reply(csms, first[1] as string);
        await csms.waitForFrame(
          (f) => callOf("StatusNotification")(f) && f[1] !== first[1],
        );
        await wait(200);
        expect(callsOf(csms, "StatusNotification")).toHaveLength(2);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("sends the next CALL after MessageTimeout without an answer", async () => {
      const csms = startMockCsms({ answerStatusNotifications: false });
      const cp = await boot(csms, version);
      try {
        cp.configuration.setRuntimeValue("MessageTimeout", 1);
        await csms.waitForFrame(callOf("StatusNotification"));
        expect(callsOf(csms, "StatusNotification")).toHaveLength(1);
        await csms.waitForFrame(
          (f) =>
            callOf("StatusNotification")(f) &&
            callsOf(csms, "StatusNotification")[0] !== f,
          5000,
        );
        expect(callsOf(csms, "StatusNotification").length).toBeGreaterThan(1);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    }, 15_000);

    // #762: the Authorize timeout starts when the CALL is written, not when it
    // is queued behind an unanswered CALL, and an unanswered Authorize on the
    // F01.FR.01 path does not authorize.
    it("an Authorize waiting for the slot does not time out before it is sent (#762)", async () => {
      const csms = startMockCsms({ answerStatusNotifications: false });
      const cp = await boot(csms, version, 1);
      try {
        await csms.waitForFrame(callOf("StatusNotification"));
        // The unanswered StatusNotification holds the slot for ~1 s; the
        // caller's own timeout (300 ms) is shorter than that.
        const outcome = cp.authorizeAndWait("TAG-762", 300, undefined, {
          failClosed: true,
        });
        const authorize = await csms.waitForCall("Authorize", 8000);
        csms.replyCallResult(authorize.messageId, {
          idTokenInfo: { status: "Blocked" },
        });
        // Before the fix this resolved "Accepted" after 300 ms, unsent.
        expect(await outcome).toBe("Blocked");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    }, 15_000);

    it("an unanswered Authorize on the remote-start path is not authorized (F01.FR.01, #762)", async () => {
      const csms = startMockCsms({ answerStatusNotifications: false });
      const cp = await boot(csms, version, 1);
      try {
        const outcome = cp.authorizeAndWait("TAG-762B", 100, undefined, {
          failClosed: true,
        });
        expect(await outcome).toBe("Unknown");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    }, 15_000);

    it("a resent Started is not overtaken by Ended (E13)", async () => {
      const csms = startMockCsms({ answerStatusNotifications: false });
      const cp = await boot(csms, version);
      cp.configuration.applyChange("TransactionMessageAttempts", "3");
      cp.configuration.applyChange("TransactionMessageRetryInterval", "1");
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      // Answer everything but the first Started with an empty result.
      let startedAttempts = 0;
      const seen = new Set<string>();
      const answerer = setInterval(() => {
        for (const f of csms.received) {
          if (f[0] !== 2 || seen.has(f[1] as string)) continue;
          seen.add(f[1] as string);
          if (f[2] === "BootNotification") continue;
          if (f[2] === "TransactionEvent") {
            const p = f[3] as TransactionEventRequestV201;
            if (p.eventType === "Started" && ++startedAttempts === 1) {
              csms.send([4, f[1], "InternalError", "first attempt fails", {}]);
              continue;
            }
          }
          csms.replyCallResult(f[1] as string, {});
        }
      }, 5);
      try {
        await cp.startTransaction("TAG-708", 1);
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).eventType === "Started",
        );
        cp.stopTransaction(1);
        await wait(2500);
        const events = callsOf(csms, "TransactionEvent").map(
          (f) => (f[3] as TransactionEventRequestV201).eventType,
        );
        expect(events).toEqual(["Started", "Started", "Ended"]);
      } finally {
        clearInterval(answerer);
        cp.disconnect();
        await csms.stop();
      }
    }, 15_000);
  },
);
