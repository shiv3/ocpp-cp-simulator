import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import type { InboundValidationMode } from "../../../domain/charge-point/ChargePoint";
import { canBindBunServe } from "../../../../test/bunServe";
import { startMockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";

/**
 * #593: an inbound 1.6J CALL with a schema-invalid payload is answered per
 * `inboundValidation`: `off` and `warn` run the handler, `enforce` answers a
 * CALLERROR. A scenario inbound policy (#247) is consulted first.
 */
async function station(mode: InboundValidationMode | undefined, id: string) {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  if (mode) cp.setInboundValidation(mode);
  const stop = answerEverythingElse(csms, []);
  const done = async () => {
    stop();
    cp.disconnect();
    await csms.stop();
  };
  return { csms, cp, done };
}

const BAD = [2, "bad-1", "UnlockConnector", { connectorId: "1" }];

const replyTo = (id: unknown) => (f: unknown[]) =>
  (f[0] === 3 || f[0] === 4) && f[1] === id;

describe.skipIf(!canBindBunServe())(
  "OCPP 1.6J inbound validation (#593)",
  () => {
    it("defaults to warn: the handler still answers a CALLRESULT", async () => {
      const { csms, cp, done } = await station(undefined, "CP-IV-DEFAULT");
      try {
        expect(cp.inboundValidation).toBe("warn");
        csms.send(BAD);
        const reply = await csms.waitForFrame(replyTo("bad-1"));
        expect(reply[0]).toBe(3);
      } finally {
        await done();
      }
    });

    it("off: no check, the handler answers", async () => {
      const { csms, done } = await station("off", "CP-IV-OFF");
      try {
        csms.send(BAD);
        const reply = await csms.waitForFrame(replyTo("bad-1"));
        expect(reply[0]).toBe(3);
      } finally {
        await done();
      }
    });

    const enforced: Array<[string, unknown[], string]> = [
      ["wrong type", BAD, "TypeConstraintViolation"],
      [
        "missing field",
        [2, "bad-2", "UnlockConnector", {}],
        "OccurenceConstraintViolation",
      ],
      [
        "bad enum",
        [2, "bad-3", "Reset", { type: "Warm" }],
        "PropertyConstraintViolation",
      ],
      [
        "unknown property",
        [2, "bad-4", "Reset", { type: "Soft", x: 1 }],
        "FormationViolation",
      ],
    ];
    for (const [name, frame, code] of enforced) {
      it(`enforce: ${name} → CALLERROR ${code}`, async () => {
        const { csms, done } = await station("enforce", `CP-IV-${code}`);
        try {
          csms.send(frame);
          const reply = await csms.waitForFrame(replyTo(frame[1]));
          expect(reply[0]).toBe(4);
          expect(reply[2]).toBe(code);
          expect(typeof reply[3]).toBe("string");
        } finally {
          await done();
        }
      });
    }

    it("enforce: a valid CALL is answered normally", async () => {
      const { csms, done } = await station("enforce", "CP-IV-VALID");
      try {
        csms.send([2, "ok-1", "UnlockConnector", { connectorId: 1 }]);
        const reply = await csms.waitForFrame(replyTo("ok-1"));
        expect(reply[0]).toBe(3);
      } finally {
        await done();
      }
    });

    it("enforce: an inbound policy keeps precedence over validation", async () => {
      const { csms, cp, done } = await station("enforce", "CP-IV-POLICY");
      try {
        cp.setInboundCallPolicy("UnlockConnector", {
          kind: "callerror",
          errorCode: "SecurityError",
          errorDescription: "policy first",
        });
        csms.send(BAD);
        const reply = await csms.waitForFrame(replyTo("bad-1"));
        expect(reply[2]).toBe("SecurityError");
        expect(reply[3]).toBe("policy first");
      } finally {
        await done();
      }
    });
  },
);
