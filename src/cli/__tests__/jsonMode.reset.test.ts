import { describe, expect, it, vi } from "vitest";

import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import { handleJsonCommand } from "../jsonMode";
import type { FacadeSingleCpTarget } from "../singleCpTarget";

const CP_ID = "bootstrap-cp";

// `reset` is a CP command method, and JSON Lines command ids are exactly those
// method names — but the switch had no `reset` case and answered
// "Unknown command: reset".
describe("JSON-Lines reset", () => {
  it("resets the charge point", async () => {
    const reset = vi.fn().mockResolvedValue(undefined);
    const target: FacadeSingleCpTarget = {
      chargePointService: {
        reset,
      } as Partial<ChargePointService> as ChargePointService,
      cpId: CP_ID,
    };

    await expect(
      handleJsonCommand(target, { command: "reset", params: {} }),
    ).resolves.toBeUndefined();
    expect(reset).toHaveBeenCalledWith(CP_ID);
  });
});
