import { describe, it, expect } from "bun:test";
import { CLIChargePointService, type CLIEvent } from "../service";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { REDACTED_VALUE } from "../../cp/shared/redaction";
import { testCpInit } from "./testCpInit";

/**
 * #396: an inbound CSMS CALL reaches the control plane as
 * csms_call_received / csms_call_completed, the payload redacted at the
 * source so JSON Lines (which writes events verbatim) never prints a secret.
 */
function setup() {
  const svc = new CLIChargePointService(testCpInit({ cpId: "cp-396" }));
  const cp = (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
  const events: CLIEvent[] = [];
  svc.onEvent((ev) => {
    if (ev.event.startsWith("csms_call_")) events.push(ev);
  });
  return { cp, events };
}

describe("#396: inbound CSMS CALL control-plane events", () => {
  it("forwards a received call and its completion", () => {
    const { cp, events } = setup();

    cp.notifyIncomingCall("Reset", { type: "Soft" }, "m-1");
    cp.notifyIncomingCallCompleted({
      action: "Reset",
      messageId: "m-1",
      outcome: "CallResult",
    });
    cp.notifyIncomingCallCompleted({
      action: "Reset",
      messageId: "m-2",
      outcome: "CallError",
      errorCode: "NotSupported",
    });

    expect(events).toEqual([
      {
        event: "csms_call_received",
        data: { action: "Reset", messageId: "m-1", payload: { type: "Soft" } },
      },
      {
        event: "csms_call_completed",
        data: { action: "Reset", messageId: "m-1", outcome: "CallResult" },
      },
      {
        event: "csms_call_completed",
        data: {
          action: "Reset",
          messageId: "m-2",
          outcome: "CallError",
          errorCode: "NotSupported",
        },
      },
    ]);
  });

  it("redacts a secret carried by the payload", () => {
    const { cp, events } = setup();

    cp.notifyIncomingCall(
      "ChangeConfiguration",
      { key: "AuthorizationKey", value: "0123456789abcdef" },
      "m-3",
    );

    expect(events[0]).toEqual({
      event: "csms_call_received",
      data: {
        action: "ChangeConfiguration",
        messageId: "m-3",
        payload: { key: "AuthorizationKey", value: REDACTED_VALUE },
      },
    });
  });
});
