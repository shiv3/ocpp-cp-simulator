import { describe, expect, it } from "vitest";

import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";

function newChargePoint(id: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

describe("incoming CSMS call observability (issue #110 engine hooks)", () => {
  it("notifyIncomingCall emits incomingCallReceived with action and payload", () => {
    const cp = newChargePoint("CP-IN-CALL");
    const seen: Array<{ action: string; payload: unknown }> = [];
    cp.events.on("incomingCallReceived", (data) => seen.push(data));

    cp.notifyIncomingCall("Reset", { type: "Soft" });

    expect(seen).toEqual([{ action: "Reset", payload: { type: "Soft" } }]);
  });

  it("response overrides are one-shot per action", () => {
    const cp = newChargePoint("CP-OVERRIDE");

    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();

    cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBe(
      "Rejected",
    );
    // consumed — second read falls through to the normal handler path
    expect(cp.consumeResponseOverride("RemoteStartTransaction")).toBeNull();
  });

  it("overrides for different actions are independent", () => {
    const cp = newChargePoint("CP-OVERRIDE-2");
    cp.armResponseOverride("TriggerMessage", "Rejected");
    expect(cp.consumeResponseOverride("ReserveNow")).toBeNull();
    expect(cp.consumeResponseOverride("TriggerMessage")).toBe("Rejected");
  });
});
