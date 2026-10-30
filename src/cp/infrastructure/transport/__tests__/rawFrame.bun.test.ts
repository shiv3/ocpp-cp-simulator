import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
} from "./stationHarness";
import { OcppCallRejectedError } from "../../../domain/errors/OcppCallErrors";

/**
 * #393, level C of #389: `ChargePoint.sendRawFrame` writes one text frame
 * as given and correlates what comes back best effort; it affects only that
 * send. A normal CALL right after it is sent, answered and correlated as
 * usual, on 1.6 and 2.x, also after the CSMS closes the connection.
 */

const VERSIONS = ["OCPP-1.6J", "OCPP-2.0.1"] as const;

const wire = (csms: MockCsms): string[] =>
  csms.connections().flatMap((c) => c.frames.map((f) => f.raw));

/** Resolves once the CSMS has seen `raw`, JSON or not. */
async function waitForRaw(csms: MockCsms, raw: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!wire(csms).includes(raw)) {
    if (Date.now() > deadline) throw new Error(`never saw ${raw}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("raw frames (#393)", () => {
  for (const version of VERSIONS) {
    it(`${version}: a malformed CALL goes out verbatim, its CALLERROR comes back, and the next CALL is normal`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-RAW-${version}`, version);
      const stopAnswering = answerEverythingElse(
        csms,
        (frame) => frame[1] === "raw-1",
      );
      try {
        // Missing payload element: not a valid CALL.
        const raw = '[2,"raw-1","Heartbeat"]';
        const sending = cp.sendRawFrame({ frame: raw, waitMs: 2000 });
        await waitForRaw(csms, raw);
        const error = [4, "raw-1", "FormationViolation", "missing payload", {}];
        csms.send(error);
        const outcome = await sending;
        expect(outcome).toEqual({
          sentFrame: raw,
          messageId: "raw-1",
          reply: error,
          closed: null,
        });

        const next = await cp.sendOcppCall({
          action: "Heartbeat",
          payload: {},
        });
        expect(next.kind).toBe("callResult");
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  }

  it("invalid JSON is written as given; a CALLERROR with id -1 is its reply", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-RAW-JSON", "OCPP-1.6J");
    const stopAnswering = answerEverythingElse(csms, []);
    try {
      const raw = "this is not json";
      const sending = cp.sendRawFrame({ frame: raw });
      await waitForRaw(csms, raw);
      const error = [4, "-1", "RpcFrameworkError", "unreadable", {}];
      csms.send(error);
      const outcome = await sending;
      expect(outcome.messageId).toBeNull();
      expect(outcome.reply).toEqual(error);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("no reply within waitMs is a result with reply null", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-RAW-QUIET", "OCPP-2.0.1");
    const stopAnswering = answerEverythingElse(csms, []);
    try {
      const outcome = await cp.sendRawFrame({
        frame: '[9,"raw-q",{}]',
        waitMs: 100,
      });
      expect(outcome).toEqual({
        sentFrame: '[9,"raw-q",{}]',
        messageId: "raw-q",
        reply: null,
        closed: null,
      });
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  for (const version of VERSIONS) {
    it(`${version}: a CSMS close in response is reported, and the next session's CALLs are normal`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-RAW-CLOSE-${version}`,
        version,
      );
      const stopAnswering = answerEverythingElse(
        csms,
        (frame) => frame[1] === "raw-c",
      );
      try {
        const raw = '[2,"raw-c"]';
        const sending = cp.sendRawFrame({ frame: raw, waitMs: 5000 });
        await waitForRaw(csms, raw);
        const opens = csms.openCount();
        csms.closeCurrentConnection(1002);
        const outcome = await sending;
        expect(outcome.reply).toBeNull();
        expect(outcome.closed).toBe("network");

        // The station reconnects on its own; once it is back, a normal CALL
        // is answered and correlated.
        const deadline = Date.now() + 10_000;
        while (csms.openCount() === opens || !cp.isOnline()) {
          if (Date.now() > deadline) throw new Error("no reconnect");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const boot = csms.received.filter(callOf("BootNotification"));
        for (const frame of boot) {
          csms.replyCallResult(frame[1] as string, {
            status: "Accepted",
            currentTime: "2026-10-30T00:00:00.000Z",
            interval: 300,
          });
        }
        const next = await cp.sendOcppCall({
          action: "Heartbeat",
          payload: {},
        });
        expect(next.kind).toBe("callResult");
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    }, 20_000);
  }

  it("a reply to the raw frame does not reach the station's handlers", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-RAW-CONSUME", "OCPP-1.6J");
    const stopAnswering = answerEverythingElse(csms, []);
    const handled: string[] = [];
    cp.events.on("log", (entry: { message?: string }) => {
      if (entry.message?.includes("raw-r")) handled.push(entry.message);
    });
    try {
      const raw = '[2,"raw-r","Heartbeat",{}]';
      const sending = cp.sendRawFrame({ frame: raw });
      await waitForRaw(csms, raw);
      const outcome = await sending;
      // answerEverythingElse answered it as a CALL: a CALLRESULT [3, id, {}].
      expect(outcome.reply).toEqual([3, "raw-r", {}]);
      expect(
        handled.filter((line) => /unexpected|Unknown/i.test(line)),
      ).toEqual([]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("SOAP stations are refused", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-RAW-SOAP", "OCPP-1.6S");
    try {
      const sending = cp.sendRawFrame({ frame: "[]" });
      await expect(sending).rejects.toBeInstanceOf(OcppCallRejectedError);
      await expect(sending).rejects.toMatchObject({
        reason: "unsupported_transport",
      });
    } finally {
      await csms.stop();
    }
  });

  it("a closed socket is refused before anything is written", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-RAW-OFF", "OCPP-2.0.1");
    try {
      cp.disconnect();
      await expect(cp.sendRawFrame({ frame: "[]" })).rejects.toMatchObject({
        reason: "not_connected",
      });
    } finally {
      await csms.stop();
    }
  });
});
