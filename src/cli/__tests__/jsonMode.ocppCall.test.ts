import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
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

// #389: the JSON-Lines surface reaches sendOcppCall with the same params the
// daemon's RPC schema admits, and returns the CSMS's answer as the result.
describe("JSON-Lines send_ocpp_call (#389)", () => {
  it("forwards the request and returns the answer", async () => {
    const outcome = {
      kind: "callResult",
      messageId: "m1",
      sentFrame: '[2,"m1","Heartbeat",{}]',
      payload: { currentTime: "2026-09-30T00:00:00.000Z" },
    };
    const sendOcppCall = vi.fn().mockResolvedValue(outcome);
    const result = await handleJsonCommand(facadeTarget({ sendOcppCall }), {
      command: "send_ocpp_call",
      params: { action: "Heartbeat", payload: {}, skipValidation: true },
    });
    expect(sendOcppCall).toHaveBeenCalledWith(CP_ID, {
      action: "Heartbeat",
      payload: {},
      skipValidation: true,
    });
    expect(result).toEqual(outcome);
  });

  it.each([
    ["a missing action", { payload: {} }, /action/],
    [
      "a payload that is not an object",
      { action: "Heartbeat", payload: "x" },
      /payload/,
    ],
    [
      "a non-boolean flag",
      { action: "Heartbeat", payload: {}, applyResponse: "yes" },
      /applyResponse/,
    ],
  ])("refuses %s", async (_label, params, message) => {
    const sendOcppCall = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendOcppCall }), {
        command: "send_ocpp_call",
        params,
      }),
    ).rejects.toThrow(message);
    expect(sendOcppCall).not.toHaveBeenCalled();
  });
});
