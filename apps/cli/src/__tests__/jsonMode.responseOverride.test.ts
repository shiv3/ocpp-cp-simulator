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

// #1095: the JSON-Lines surface arms response overrides and sends a
// CALLRESULTERROR with the control plane's own schema.
describe("JSON-Lines response control (#1095)", () => {
  it("arms an override with the mode's fields", async () => {
    const setResponseOverride = vi
      .fn()
      .mockResolvedValue({ action: "Reset", mode: "callError" });
    const params = {
      action: "Reset",
      mode: "callError",
      errorCode: "SecurityError",
      errorDescription: "no",
      errorDetails: { a: 1 },
      times: 2,
    };
    const result = await handleJsonCommand(
      facadeTarget({ setResponseOverride }),
      { command: "set_response_override", params },
    );
    expect(setResponseOverride).toHaveBeenCalledWith(CP_ID, params);
    expect(result).toEqual({ action: "Reset", mode: "callError" });
  });

  it("refuses an unknown mode without calling the service", async () => {
    const setResponseOverride = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ setResponseOverride }), {
        command: "set_response_override",
        params: { action: "Reset", mode: "explode" },
      }),
    ).rejects.toThrow(/mode/);
    expect(setResponseOverride).not.toHaveBeenCalled();
  });

  it("clears one override or all of them", async () => {
    const clearResponseOverrides = vi.fn().mockResolvedValue(1);
    const target = facadeTarget({ clearResponseOverrides });
    expect(
      await handleJsonCommand(target, {
        command: "clear_response_overrides",
        params: { action: "Reset" },
      }),
    ).toEqual({ cleared: 1 });
    expect(clearResponseOverrides).toHaveBeenCalledWith(CP_ID, "Reset");
    await handleJsonCommand(target, {
      command: "clear_response_overrides",
      params: {},
    });
    expect(clearResponseOverrides).toHaveBeenLastCalledWith(CP_ID, undefined);
  });

  it("sends a CALLRESULTERROR", async () => {
    const sendCallResultError = vi
      .fn()
      .mockResolvedValue({ sentFrame: "[5]", messageId: "m-1" });
    const result = await handleJsonCommand(
      facadeTarget({ sendCallResultError }),
      { command: "send_call_result_error", params: { messageId: "m-1" } },
    );
    expect(sendCallResultError).toHaveBeenCalledWith(CP_ID, {
      messageId: "m-1",
    });
    expect(result).toEqual({ sentFrame: "[5]", messageId: "m-1" });
  });
});
