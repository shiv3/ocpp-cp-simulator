import { describe, expect, it } from "bun:test";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { canBindBunServe } from "../../../../test/bunServe";

/**
 * #474 over a real socket: which closes put the charge point in error.
 */
async function connectedChargePoint(csms: MockCsms) {
  const cp = new ChargePoint(
    "CP-CLOSE-ERROR",
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  const errors: string[] = [];
  cp.events.on("error", ({ error }) => {
    errors.push(error);
  });
  cp.connect();
  await csms.waitForCall("BootNotification", 8000);
  const disconnected = new Promise<{ code: number }>((resolve) => {
    cp.events.once("disconnected", resolve);
  });
  return { cp, errors, disconnected };
}

describe.skipIf(!canBindBunServe())("WebSocket close → error (#474)", () => {
  it("a CSMS normal closure (1000) is not an error", async () => {
    const csms = startMockCsms();
    const { cp, errors, disconnected } = await connectedChargePoint(csms);
    try {
      csms.closeCurrentConnection(1000);

      expect((await disconnected).code).toBe(1000);
      expect(errors).toEqual([]);
      expect(cp.error).toBe("");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("an operator disconnect is not an error", async () => {
    const csms = startMockCsms();
    const { cp, errors, disconnected } = await connectedChargePoint(csms);
    try {
      cp.disconnect();

      await disconnected;
      expect(errors).toEqual([]);
      expect(cp.error).toBe("");
    } finally {
      await csms.stop();
    }
  });

  it("a CSMS internal-error closure (1011) is an error", async () => {
    const csms = startMockCsms();
    const { cp, errors, disconnected } = await connectedChargePoint(csms);
    try {
      csms.closeCurrentConnection(1011);

      expect((await disconnected).code).toBe(1011);
      // Only the first event: the reconnect's boot clears the error again.
      expect(errors[0]).toBe("WebSocket closed code: 1011 reason: ");
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
