import { describe, it, expect, vi } from "vitest";
import { Connector } from "../../../domain/connector/Connector";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ScenarioManager } from "../ScenarioManager";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";

// #425: an explicit run starts whatever the charge point's status, like the
// daemon's runScenario; only the statusChange trigger waits for Available.

// Start -> StatusNotification(Preparing) -> End.
function preparingScenario(
  trigger: ScenarioDefinition["trigger"],
): ScenarioDefinition {
  return {
    id: "sc-gate",
    name: "availability gate",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "set",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 0, y: 100 },
        data: { label: "Set", status: OCPPStatus.Preparing },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start", source: "start", target: "set" },
      { id: "e-set", source: "set", target: "end" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger,
  };
}

function newManager(status: OCPPStatus) {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  const updateConnectorStatus = vi.fn();
  const chargePoint = {
    status,
    logger: new Logger(LogLevel.ERROR),
    updateConnectorStatus,
  } as unknown as ChargePoint;
  const callbacks = createScenarioExecutorCallbacks({ chargePoint, connector });
  const manager = new ScenarioManager(connector, chargePoint, callbacks);
  return { manager, updateConnectorStatus };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const NOT_AVAILABLE = [
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
  OCPPStatus.Charging,
];

describe("ScenarioManager availability gate (#425)", () => {
  it.each(NOT_AVAILABLE)(
    "executeScenario runs a scenario while the charge point is %s",
    async (status) => {
      const { manager, updateConnectorStatus } = newManager(status);
      manager.loadScenarios([preparingScenario({ type: "manual" })]);

      await manager.executeScenario("sc-gate");

      expect(updateConnectorStatus).toHaveBeenCalledWith(
        1,
        OCPPStatus.Preparing,
      );
      expect(manager.getActiveScenarioIds()).toEqual([]);
    },
  );

  it("manualExecute runs a scenario while the charge point is not Available", async () => {
    const { manager, updateConnectorStatus } = newManager(
      OCPPStatus.Unavailable,
    );
    manager.loadScenarios([preparingScenario({ type: "manual" })]);

    await manager.manualExecute("sc-gate");

    expect(updateConnectorStatus).toHaveBeenCalledWith(1, OCPPStatus.Preparing);
  });

  const statusChangeTrigger: ScenarioDefinition["trigger"] = {
    type: "statusChange",
    conditions: { toStatus: OCPPStatus.Charging },
  };

  it.each(NOT_AVAILABLE)(
    "a statusChange trigger does not start a scenario while the charge point is %s",
    async (status) => {
      const { manager, updateConnectorStatus } = newManager(status);
      manager.loadScenarios([preparingScenario(statusChangeTrigger)]);

      manager.evaluateStatus(OCPPStatus.Available, OCPPStatus.Charging);
      await settle();

      expect(manager.getActiveScenarioIds()).toEqual([]);
      expect(updateConnectorStatus).not.toHaveBeenCalled();
    },
  );

  it("a statusChange trigger starts the scenario while the charge point is Available", async () => {
    const { manager, updateConnectorStatus } = newManager(OCPPStatus.Available);
    manager.loadScenarios([preparingScenario(statusChangeTrigger)]);

    manager.evaluateStatus(OCPPStatus.Available, OCPPStatus.Charging);
    await settle();

    expect(updateConnectorStatus).toHaveBeenCalledWith(1, OCPPStatus.Preparing);
  });
});
