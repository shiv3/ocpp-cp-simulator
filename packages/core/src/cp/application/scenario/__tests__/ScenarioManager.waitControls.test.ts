import { describe, it, expect } from "vitest";
import { Connector } from "../../../domain/connector/Connector";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ScenarioManager } from "../ScenarioManager";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";

// Start -> wait for a status this test never reaches -> End.
function parkingScenario(timeout: number): ScenarioDefinition {
  return {
    id: "sc-wait-controls",
    name: "wait controls",
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
        id: "wait",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 0, y: 100 },
        data: { label: "Wait", targetStatus: OCPPStatus.Charging, timeout },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start", source: "start", target: "wait" },
      { id: "e-wait", source: "wait", target: "end" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

function newManager(): ScenarioManager {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  const chargePoint = {
    status: OCPPStatus.Available,
    logger: new Logger(LogLevel.ERROR),
  } as unknown as ChargePoint;
  const callbacks = createScenarioExecutorCallbacks({ chargePoint, connector });
  return new ScenarioManager(connector, chargePoint, callbacks);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("ScenarioManager wait controls (#240)", () => {
  it("refuses a control on a scenario that is not running", () => {
    const manager = newManager();
    manager.loadScenarios([parkingScenario(60)]);

    expect(() => manager.continueWait("sc-wait-controls")).toThrow(
      "Scenario sc-wait-controls is not running",
    );
  });

  it("extends, then continues past, a parked wait", async () => {
    const manager = newManager();
    manager.loadScenarios([parkingScenario(60)]);
    const run = manager.executeScenario("sc-wait-controls");
    await settle();

    const deadline =
      manager.getScenarioExecutionContext("sc-wait-controls")!.waitDeadlineAt!;
    manager.extendWait("sc-wait-controls", 30);
    expect(
      manager.getScenarioExecutionContext("sc-wait-controls")!.waitDeadlineAt,
    ).toBe(deadline + 30_000);

    manager.retryWait("sc-wait-controls");
    await settle();
    manager.continueWait("sc-wait-controls");
    await run;

    expect(manager.getScenarioExecutionContext("sc-wait-controls")).toBeNull();
  });
});
