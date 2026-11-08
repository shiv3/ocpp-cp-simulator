import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { canBindBunServe } from "../../../../test/bunServe";
import { startMockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";
import type { ChargePointCapabilityProfile } from "../../../domain/charge-point/CapabilityProfile";

/**
 * #618: a static capability profile makes a station lack features. A disabled
 * action is answered CALLERROR NotImplemented (OCPP-J 1.6 §4.2.3), a
 * TriggerMessage target outside the list is answered status NotImplemented
 * (1.6 §5.17, 2.x F06), a scenario inbound policy keeps precedence and no
 * profile changes nothing.
 */
const replyTo = (id: unknown) => (f: unknown[]) =>
  (f[0] === 3 || f[0] === 4) && f[1] === id;

async function station(
  version: string,
  id: string,
  profile?: ChargePointCapabilityProfile,
) {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, version, {
    ...(profile ? { capabilityProfile: profile } : {}),
  });
  const stop = answerEverythingElse(csms, []);
  const done = async () => {
    stop();
    cp.disconnect();
    await csms.stop();
  };
  return { csms, cp, done };
}

describe.skipIf(!canBindBunServe())("capability profile (#618)", () => {
  it("1.6J: a disabled action answers CALLERROR NotImplemented", async () => {
    const { csms, done } = await station("OCPP-1.6J", "CP-CAP-1", {
      disabledActions: ["GetCompositeSchedule"],
    });
    try {
      csms.send([
        2,
        "g-1",
        "GetCompositeSchedule",
        { connectorId: 1, duration: 60 },
      ]);
      const reply = await csms.waitForFrame(replyTo("g-1"));
      expect(reply[0]).toBe(4);
      expect(reply[2]).toBe("NotImplemented");
      // Other actions are untouched.
      csms.send([2, "u-1", "UnlockConnector", { connectorId: 1 }]);
      expect((await csms.waitForFrame(replyTo("u-1")))[0]).toBe(3);
    } finally {
      await done();
    }
  });

  it("1.6J: a scenario inbound policy keeps precedence", async () => {
    const { csms, cp, done } = await station("OCPP-1.6J", "CP-CAP-2", {
      disabledActions: ["Reset"],
    });
    try {
      cp.setInboundCallPolicy("Reset", {
        kind: "callerror",
        errorCode: "NotSupported",
        errorDescription: "policy wins",
      });
      csms.send([2, "r-1", "Reset", { type: "Soft" }]);
      const reply = await csms.waitForFrame(replyTo("r-1"));
      expect(reply[2]).toBe("NotSupported");
      expect(reply[3]).toBe("policy wins");

      cp.clearInboundCallPolicy("Reset");
      csms.send([2, "r-2", "Reset", { type: "Soft" }]);
      expect((await csms.waitForFrame(replyTo("r-2")))[2]).toBe(
        "NotImplemented",
      );
    } finally {
      await done();
    }
  });

  it("1.6J: TriggerMessage targets are limited, ExtendedTriggerMessage follows", async () => {
    const { csms, done } = await station("OCPP-1.6J", "CP-CAP-3", {
      triggerMessageTargets: ["Heartbeat"],
    });
    try {
      csms.send([
        2,
        "t-1",
        "TriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);
      expect((await csms.waitForFrame(replyTo("t-1")))[2]).toEqual({
        status: "Accepted",
      });
      csms.send([
        2,
        "t-2",
        "TriggerMessage",
        { requestedMessage: "MeterValues", connectorId: 1 },
      ]);
      expect((await csms.waitForFrame(replyTo("t-2")))[2]).toEqual({
        status: "NotImplemented",
      });
      csms.send([
        2,
        "t-3",
        "ExtendedTriggerMessage",
        { requestedMessage: "SignChargePointCertificate" },
      ]);
      expect((await csms.waitForFrame(replyTo("t-3")))[2]).toEqual({
        status: "NotImplemented",
      });
    } finally {
      await done();
    }
  });

  it("1.6J: a code behavior cannot accept a TriggerMessage target the profile leaves out", async () => {
    const { csms, cp, done } = await station("OCPP-1.6J", "CP-CAP-B", {
      triggerMessageTargets: ["Heartbeat"],
    });
    try {
      cp.loadBehavior({
        api: 1,
        id: "accept-all-triggers",
        onCall: {
          TriggerMessage: {
            mode: "replace",
            handle: () => ({ response: { status: "Accepted" } }),
          },
        },
      });
      csms.send([
        2,
        "b-1",
        "TriggerMessage",
        { requestedMessage: "MeterValues", connectorId: 1 },
      ]);
      expect((await csms.waitForFrame(replyTo("b-1")))[2]).toEqual({
        status: "NotImplemented",
      });
      csms.send([
        2,
        "b-2",
        "TriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);
      expect((await csms.waitForFrame(replyTo("b-2")))[2]).toEqual({
        status: "Accepted",
      });
    } finally {
      await done();
    }
  });

  it("1.6J: disabling TriggerMessage leaves ExtendedTriggerMessage alone", async () => {
    const { csms, done } = await station("OCPP-1.6J", "CP-CAP-4", {
      disabledActions: ["TriggerMessage"],
    });
    try {
      csms.send([
        2,
        "t-1",
        "TriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);
      expect((await csms.waitForFrame(replyTo("t-1")))[2]).toBe(
        "NotImplemented",
      );
      csms.send([
        2,
        "t-2",
        "ExtendedTriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);
      expect((await csms.waitForFrame(replyTo("t-2")))[0]).toBe(3);
    } finally {
      await done();
    }
  });

  it("no profile: current behavior", async () => {
    const { csms, done } = await station("OCPP-1.6J", "CP-CAP-5");
    try {
      csms.send([
        2,
        "t-1",
        "TriggerMessage",
        { requestedMessage: "MeterValues", connectorId: 1 },
      ]);
      expect((await csms.waitForFrame(replyTo("t-1")))[2]).toEqual({
        status: "Accepted",
      });
    } finally {
      await done();
    }
  });

  it("2.0.1: a 1.6 spelling disables the 2.x action; targets are limited", async () => {
    const { csms, done } = await station("OCPP-2.0.1", "CP-CAP-6", {
      disabledActions: ["RemoteStartTransaction"],
      triggerMessageTargets: ["Heartbeat"],
    });
    try {
      csms.send([
        2,
        "s-1",
        "RequestStartTransaction",
        {
          idToken: { idToken: "T", type: "ISO14443" },
          remoteStartId: 1,
          evseId: 1,
        },
      ]);
      const refused = await csms.waitForFrame(replyTo("s-1"));
      expect(refused[0]).toBe(4);
      expect(refused[2]).toBe("NotImplemented");

      csms.send([
        2,
        "t-1",
        "TriggerMessage",
        { requestedMessage: "StatusNotification", evse: { id: 1 } },
      ]);
      expect((await csms.waitForFrame(replyTo("t-1")))[2]).toEqual({
        status: "NotImplemented",
      });
      csms.send([
        2,
        "t-2",
        "TriggerMessage",
        { requestedMessage: "Heartbeat" },
      ]);
      expect((await csms.waitForFrame(replyTo("t-2")))[2]).toEqual({
        status: "Accepted",
      });
    } finally {
      await done();
    }
  });
});
