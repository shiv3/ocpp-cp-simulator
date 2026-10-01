import { describe, it, expect } from "bun:test";
import { answerTo, startMockCsms, type MockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";

/**
 * #406: `WebSocketPingInterval` was accepted and stored, but no ping frame
 * ever left the station. Driven over a real Bun WebSocket, the CSMS now
 * counts the pings the key asks for — and none once it is set back to 0.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pings = (csms: MockCsms) => csms.connections().at(-1)?.pings ?? 0;

/** Polls rather than sleeping a fixed time, so a loaded runner is not a fail. */
async function waitForPings(csms: MockCsms, n: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (pings(csms) < n) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${n} pings, got ${pings(csms)}`);
    }
    await sleep(50);
  }
}

describe("WebSocketPingInterval sends ping frames (#406)", () => {
  it("1.6J: ChangeConfiguration arms and disarms the ping", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PING", "OCPP-1.6J");
    const stop = answerEverythingElse(csms, []);
    try {
      csms.send([
        2,
        "cc-on",
        "ChangeConfiguration",
        { key: "WebSocketPingInterval", value: "1" },
      ]);
      expect(await csms.waitForFrame(answerTo("cc-on"))).toEqual([
        3,
        "cc-on",
        { status: "Accepted" },
      ]);
      await waitForPings(csms, 1);

      csms.send([
        2,
        "cc-off",
        "ChangeConfiguration",
        { key: "WebSocketPingInterval", value: "0" },
      ]);
      await csms.waitForFrame(answerTo("cc-off"));
      const afterOff = pings(csms);
      await sleep(1_200); // longer than the 1 s interval
      expect(pings(csms)).toBe(afterOff);
    } finally {
      stop();
      cp.disconnect();
      await csms.stop();
    }
  }, 15_000);

  it("2.0.1: SetVariables on OCPPCommCtrlr arms the ping", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-PING", "OCPP-2.0.1");
    try {
      csms.send([
        2,
        "sv-on",
        "SetVariables",
        {
          setVariableData: [
            {
              attributeValue: "1",
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "WebSocketPingInterval" },
            },
          ],
        },
      ]);
      const answer = await csms.waitForFrame(answerTo("sv-on"));
      expect(answer[2]).toMatchObject({
        setVariableResult: [{ attributeStatus: "Accepted" }],
      });
      await waitForPings(csms, 1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  }, 15_000);
});
