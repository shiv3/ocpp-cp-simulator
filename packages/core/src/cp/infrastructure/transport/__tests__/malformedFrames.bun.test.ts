import { describe, expect, it } from "bun:test";
import { startMockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";

/**
 * #1060: a station answers the malformed frames a CSMS sends with the
 * CALLERROR OCPP-J asks for, on the wire, and ignores the ones no answer is
 * due for. The rules: docs/analyses/ocpp-protocol-stack.md#malformed-frames.
 */

const VERSIONS = [
  ["OCPP-1.6J", "GenericError"],
  ["OCPP-2.0.1", "RpcFrameworkError"],
  ["OCPP-2.1", "RpcFrameworkError"],
] as const;

describe("malformed frames from the CSMS (#1060)", () => {
  for (const [version, code] of VERSIONS) {
    it(`${version}: answers what is due and nothing else`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-MALFORMED-${version}`,
        version,
      );
      const stopAnswering = answerEverythingElse(csms, []);
      const errorFor = (id: string) => (frame: unknown[]) =>
        frame[0] === 4 && frame[1] === id;
      try {
        csms.sendText("this is not json");
        expect(await csms.waitForFrame(errorFor("-1"))).toEqual([
          4,
          "-1",
          code,
          "Message is not valid JSON",
          {},
        ]);

        csms.sendText('[2,"w1","Reset"]');
        expect(await csms.waitForFrame(errorFor("w1"))).toEqual([
          4,
          "w1",
          code,
          "CALL does not have 4 elements",
          {},
        ]);

        // No answer is due for these; a CALL sent after them is answered,
        // and by then nothing answered them.
        csms.sendText('[7,"u1","X",{}]');
        csms.sendText('[3,"u2",{},{}]');
        csms.sendText('[4,"u3",42,"no",{}]');
        csms.sendText('[2,"probe","NoSuchAction",{}]');
        await csms.waitForFrame(errorFor("probe"));
        const answered = csms.received.filter(
          (frame) =>
            (frame[0] === 3 || frame[0] === 4) &&
            ["u1", "u2", "u3"].includes(frame[1] as string),
        );
        expect(answered).toEqual([]);
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
