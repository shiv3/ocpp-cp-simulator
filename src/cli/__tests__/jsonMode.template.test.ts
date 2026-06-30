import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { CLIChargePointService } from "../service";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

// run_scenario_template / load_scenario_template should accept an optional
// `evSettings` override so a connector's charging power (=> low-power
// eligibility) can be set without authoring a whole custom scenario — the
// template's own evSettings would otherwise clobber a prior set_ev_settings.
describe("(load|run)_scenario_template evSettings override", () => {
  it("forwards evSettings to loadScenarioTemplate and runs the scenario", async () => {
    const loadScenarioTemplate = vi.fn().mockReturnValue("sid-1");
    const runScenario = vi.fn();
    const service = {
      loadScenarioTemplate,
      runScenario,
    } as unknown as CLIChargePointService;

    const res = await handleJsonCommand(service, {
      command: "run_scenario_template",
      params: {
        connector: 1,
        templateId: "essential-cp-behavior",
        evSettings: { maxChargingPowerKw: 3 },
      },
    });

    expect(loadScenarioTemplate).toHaveBeenCalledWith(
      "essential-cp-behavior",
      1,
      { maxChargingPowerKw: 3 },
    );
    expect(runScenario).toHaveBeenCalledWith(1, "sid-1");
    expect(res).toEqual({ scenarioId: "sid-1" });
  });

  it("load_scenario_template forwards evSettings too", async () => {
    const loadScenarioTemplate = vi.fn().mockReturnValue("sid-2");
    const service = {
      loadScenarioTemplate,
    } as unknown as CLIChargePointService;

    await handleJsonCommand(service, {
      command: "load_scenario_template",
      params: {
        connector: 2,
        templateId: "full-charging-cycle",
        evSettings: { maxChargingPowerKw: 6 },
      },
    });

    expect(loadScenarioTemplate).toHaveBeenCalledWith(
      "full-charging-cycle",
      2,
      { maxChargingPowerKw: 6 },
    );
  });

  it("omits the override when no evSettings is given", async () => {
    const loadScenarioTemplate = vi.fn().mockReturnValue("sid-3");
    const runScenario = vi.fn();
    const service = {
      loadScenarioTemplate,
      runScenario,
    } as unknown as CLIChargePointService;

    await handleJsonCommand(service, {
      command: "run_scenario_template",
      params: { connector: 1, templateId: "smart-charging" },
    });

    expect(loadScenarioTemplate).toHaveBeenCalledWith(
      "smart-charging",
      1,
      undefined,
    );
  });
});

describe("update_connector_status status notification options", () => {
  it("forwards all wire options to the per-CP service", async () => {
    const updateConnectorStatus = vi.fn();
    const service = {
      updateConnectorStatus,
    } as unknown as CLIChargePointService;

    await handleJsonCommand(service, {
      command: "update_connector_status",
      params: {
        connector: 1,
        status: "Faulted",
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp: "2026-01-02T03:04:05.000Z",
        suppressChargingStateTransactionEvent: true,
      },
    });

    expect(updateConnectorStatus).toHaveBeenCalledTimes(1);
    const [connectorId, status, opts] = updateConnectorStatus.mock.calls[0];
    expect(connectorId).toBe(1);
    expect(status).toBe(OCPPStatus.Faulted);
    expect(opts).toMatchObject({
      errorCode: "EVCommunicationError",
      info: "pilot lost",
      vendorErrorCode: "E-42",
      vendorId: "Vendor",
      suppressChargingStateTransactionEvent: true,
    });
    expect(opts.timestamp).toBeInstanceOf(Date);
    expect(opts.timestamp.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});
