import { describe, expect, it, vi } from "vitest";

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

// #537: the JSON-Lines surface applies the control plane's bounds
// (type string[0..50], techInfo string[0..255]).
describe("JSON-Lines security_event_notification (#537)", () => {
  it("forwards type and techInfo", async () => {
    const sendSecurityEventNotification = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ sendSecurityEventNotification }), {
      command: "security_event_notification",
      params: { type: "SettingSystemTime", techInfo: "ntp" },
    });
    expect(sendSecurityEventNotification).toHaveBeenCalledWith(
      CP_ID,
      "SettingSystemTime",
      "ntp",
    );
  });

  it.each([
    ["a 51-character type", { type: "t".repeat(51) }],
    [
      "a 256-character techInfo",
      { type: "SettingSystemTime", techInfo: "i".repeat(256) },
    ],
    ["an empty type", { type: "" }],
  ])("refuses %s before reaching the station", async (_label, params) => {
    const sendSecurityEventNotification = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendSecurityEventNotification }), {
        command: "security_event_notification",
        params,
      }),
    ).rejects.toThrow(/Missing or invalid parameter/);
    expect(sendSecurityEventNotification).not.toHaveBeenCalled();
  });
});
