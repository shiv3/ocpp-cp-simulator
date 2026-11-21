import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { ChargePointService } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type { FacadeSingleCpTarget } from "../singleCpTarget";

const CP_ID = "bootstrap-cp";

function facadeTarget(
  chargePointService: Partial<ChargePointService>,
): FacadeSingleCpTarget {
  return {
    chargePointService: chargePointService as ChargePointService,
    cpId: CP_ID,
  };
}

// #1096 / #1097: JSON-Lines sends an OCPP 2.1 SEND and a CALL without a payload.
describe("JSON-Lines send_ocpp_send and payload-less send_ocpp_call", () => {
  it("sends a SEND with the control plane's own schema", async () => {
    const sendOcppSend = vi
      .fn()
      .mockResolvedValue({ messageId: "m-1", sentFrame: '[6,"m-1"]' });
    const params = {
      action: "NotifyPeriodicEventStream",
      skipValidation: true,
    };
    const result = await handleJsonCommand(facadeTarget({ sendOcppSend }), {
      command: "send_ocpp_send",
      params,
    });
    expect(sendOcppSend).toHaveBeenCalledWith(CP_ID, params);
    expect(result).toEqual({ messageId: "m-1", sentFrame: '[6,"m-1"]' });
  });

  it("refuses a SEND without an action", async () => {
    const sendOcppSend = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendOcppSend }), {
        command: "send_ocpp_send",
        params: { payload: {} },
      }),
    ).rejects.toThrow(/action/);
    expect(sendOcppSend).not.toHaveBeenCalled();
  });

  it("sends a CALL with no payload, leaving the default to the station", async () => {
    const sendOcppCall = vi.fn().mockResolvedValue({ kind: "callResult" });
    await handleJsonCommand(facadeTarget({ sendOcppCall }), {
      command: "send_ocpp_call",
      params: { action: "NotifySettlement" },
    });
    expect(sendOcppCall).toHaveBeenCalledWith(CP_ID, {
      action: "NotifySettlement",
    });
  });
});
