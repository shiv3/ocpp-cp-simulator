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

// #240: the JSON-Lines surface forwards the three wait controls, and holds
// the same `seconds` contract (1–3600) as the control plane.
describe("JSON-Lines scenario wait controls (#240)", () => {
  it.each([
    {
      command: "extend_scenario_wait",
      method: "extendScenarioWait",
      params: { connector: 1, scenarioId: "s1", seconds: 30 },
      args: [CP_ID, 1, "s1", 30],
    },
    {
      command: "retry_scenario_wait",
      method: "retryScenarioWait",
      params: { connector: 1, scenarioId: "s1" },
      args: [CP_ID, 1, "s1"],
    },
    {
      command: "continue_scenario_wait",
      method: "continueScenarioWait",
      params: { connector: 1, scenarioId: "s1" },
      args: [CP_ID, 1, "s1"],
    },
  ] as const)(
    "$command forwards to $method",
    async ({ command, method, params, args }) => {
      const control = vi.fn().mockResolvedValue(undefined);
      await handleJsonCommand(facadeTarget({ [method]: control }), {
        command,
        params,
      });
      expect(control).toHaveBeenCalledWith(...args);
    },
  );

  it("accepts an extension of 3600 seconds", async () => {
    const extendScenarioWait = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ extendScenarioWait }), {
      command: "extend_scenario_wait",
      params: { connector: 1, scenarioId: "s1", seconds: 3600 },
    });
    expect(extendScenarioWait).toHaveBeenCalledWith(CP_ID, 1, "s1", 3600);
  });

  it("refuses an extension above 3600 seconds before reaching the service", async () => {
    const extendScenarioWait = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ extendScenarioWait }), {
        command: "extend_scenario_wait",
        params: { connector: 1, scenarioId: "s1", seconds: 3601 },
      }),
    ).rejects.toThrow(/seconds/);
    expect(extendScenarioWait).not.toHaveBeenCalled();
  });
});
