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

// #352: `once` (and `strict`, which this surface used to drop) reach the
// service exactly as the RPC table declares them.
describe("JSON-Lines run_scenario_template parameters (#352)", () => {
  it("forwards once and strict", async () => {
    const runScenarioTemplate = vi.fn().mockResolvedValue({ scenarioId: "s" });
    await handleJsonCommand(facadeTarget({ runScenarioTemplate }), {
      command: "run_scenario_template",
      params: {
        connector: 2,
        templateId: "cert16-tc001-cold-boot",
        once: true,
        strict: false,
      },
    });
    expect(runScenarioTemplate).toHaveBeenCalledWith(
      CP_ID,
      "cert16-tc001-cold-boot",
      { connectorId: 2, evSettings: undefined, strict: false, once: true },
    );
  });

  it("omits both when absent", async () => {
    const runScenarioTemplate = vi.fn().mockResolvedValue({ scenarioId: "s" });
    await handleJsonCommand(facadeTarget({ runScenarioTemplate }), {
      command: "run_scenario_template",
      params: { connector: 1, templateId: "cert16-tc001-cold-boot" },
    });
    expect(runScenarioTemplate).toHaveBeenCalledWith(
      CP_ID,
      "cert16-tc001-cold-boot",
      { connectorId: 1, evSettings: undefined },
    );
  });

  it("rejects a non-boolean once", async () => {
    const runScenarioTemplate = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ runScenarioTemplate }), {
        command: "run_scenario_template",
        params: { connector: 1, templateId: "x", once: "yes" },
      }),
    ).rejects.toThrow(/once/);
    expect(runScenarioTemplate).not.toHaveBeenCalled();
  });
});
