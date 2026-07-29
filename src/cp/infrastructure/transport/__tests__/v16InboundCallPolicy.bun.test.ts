import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms } from "./mockCsms";

function canBindBunServe(): boolean {
  try {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function acceptBootAndDrainStartup(
  csms: ReturnType<typeof startMockCsms>,
): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-30T00:00:00.000Z",
    interval: 300,
  });

  const status0 = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorId?: number }).connectorId === 0,
  );
  csms.replyCallResult(status0[1] as string, {});

  const status1 = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorId?: number }).connectorId === 1,
  );
  csms.replyCallResult(status1[1] as string, {});
}

describe.skipIf(!canBindBunServe())(
  "OCPP 1.6 inbound call policy (issue #247)",
  () => {
    it("callerror policy on GetConfiguration → inbound CALL produces CALLERROR and no CALLRESULT", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-POLICY-CALLERROR",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        await acceptBootAndDrainStartup(csms);

        // Arm callerror policy on GetConfiguration
        cp.setInboundCallPolicy("GetConfiguration", {
          kind: "callerror",
          errorCode: "SecurityError",
          errorDescription: "Policy denied GetConfiguration",
        });

        // Send GetConfiguration from CSMS
        csms.send([2, "config-call-1", "GetConfiguration", {}]);

        // Expect CALLERROR [4, id, errorCode, errorDescription, errorDetails]
        const errorFrame = await csms.waitForFrame(
          (f) =>
            f[0] === 4 && f[1] === "config-call-1" && f[2] === "SecurityError",
        );
        expect(errorFrame[0]).toBe(4); // CALLERROR type
        expect(errorFrame[1]).toBe("config-call-1"); // message ID
        expect(errorFrame[2]).toBe("SecurityError"); // error code
        expect(errorFrame[3]).toBe("Policy denied GetConfiguration"); // error description

        // Should NOT send a CALLRESULT [3, id, payload]
        const resultFrame = csms.received.find(
          (f) => f[0] === 3 && f[1] === "config-call-1",
        );
        expect(resultFrame).toBeUndefined();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("ignore policy → no frame at all is written in response", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-POLICY-IGNORE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        await acceptBootAndDrainStartup(csms);

        const initialFrameCount = csms.received.length;

        // Arm ignore policy on GetConfiguration
        cp.setInboundCallPolicy("GetConfiguration", {
          kind: "ignore",
        });

        // Send GetConfiguration from CSMS
        csms.send([2, "config-call-2", "GetConfiguration", {}]);

        // Wait a bit to ensure no response arrives
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Check that no response frame was added after the call
        const newFrames = csms.received.slice(initialFrameCount);
        const responseToCall2 = newFrames.find(
          (f) => (f[0] === 3 || f[0] === 4) && f[1] === "config-call-2",
        );
        expect(responseToCall2).toBeUndefined();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("un-policied actions still answer normally while a policy exists for another action", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-POLICY-MIXED",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        await acceptBootAndDrainStartup(csms);

        // Arm ignore policy on GetConfiguration only
        cp.setInboundCallPolicy("GetConfiguration", {
          kind: "ignore",
        });

        // Send ClearCache (not policied) from CSMS
        csms.send([2, "cache-call-1", "ClearCache", {}]);

        // Expect CALLRESULT [3, id, payload]
        const cacheResult = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "cache-call-1",
        );
        expect(cacheResult[0]).toBe(3); // CALLRESULT type
        expect(cacheResult[1]).toBe("cache-call-1");
        expect((cacheResult[2] as { status: string }).status).toBe("Accepted");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("clearInboundCallPolicy(action) restores normal CALLRESULT behavior", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-POLICY-CLEAR-ONE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        await acceptBootAndDrainStartup(csms);

        // Arm ignore policy on GetConfiguration
        cp.setInboundCallPolicy("GetConfiguration", {
          kind: "ignore",
        });

        // Send GetConfiguration (should be ignored)
        csms.send([2, "config-call-3", "GetConfiguration", {}]);

        // Wait a bit to ensure no response arrives
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify it was ignored
        let response = csms.received.find(
          (f) => (f[0] === 3 || f[0] === 4) && f[1] === "config-call-3",
        );
        expect(response).toBeUndefined();

        // Clear the policy for GetConfiguration
        cp.clearInboundCallPolicy("GetConfiguration");

        // Send GetConfiguration again (should get normal CALLRESULT)
        csms.send([2, "config-call-4", "GetConfiguration", {}]);

        // Expect CALLRESULT
        response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "config-call-4",
        );
        expect(response[0]).toBe(3); // CALLRESULT type
        expect(response[1]).toBe("config-call-4");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("clearInboundCallPolicy() with no args clears everything", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP016-POLICY-CLEAR-ALL",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        await acceptBootAndDrainStartup(csms);

        // Arm ignore policy on both GetConfiguration and ClearCache
        cp.setInboundCallPolicy("GetConfiguration", {
          kind: "ignore",
        });
        cp.setInboundCallPolicy("ClearCache", {
          kind: "callerror",
          errorCode: "SecurityError",
          errorDescription: "Denied",
        });

        // Send GetConfiguration (should be ignored)
        csms.send([2, "config-call-5", "GetConfiguration", {}]);

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify it was ignored
        let response = csms.received.find(
          (f) => (f[0] === 3 || f[0] === 4) && f[1] === "config-call-5",
        );
        expect(response).toBeUndefined();

        // Clear ALL policies
        cp.clearInboundCallPolicy();

        // Send GetConfiguration again (should get normal CALLRESULT)
        csms.send([2, "config-call-6", "GetConfiguration", {}]);

        response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "config-call-6",
        );
        expect(response[0]).toBe(3);

        // Send ClearCache (should also get normal CALLRESULT, not CALLERROR)
        csms.send([2, "cache-call-1", "ClearCache", {}]);

        response = await csms.waitForFrame(
          (f) => f[0] === 3 && f[1] === "cache-call-1",
        );
        expect(response[0]).toBe(3);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
