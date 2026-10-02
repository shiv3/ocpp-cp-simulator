import { describe, expect, it } from "vitest";

import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Connector } from "../../../domain/connector/Connector";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";
import { ScenarioManager } from "../ScenarioManager";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ScenarioNodeType, type ScenarioDefinition } from "../ScenarioTypes";

const triggered: ScenarioDefinition = {
  id: "on-charging",
  name: "on charging",
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
      id: "end",
      type: ScenarioNodeType.END,
      position: { x: 0, y: 0 },
      data: { label: "End" },
    },
  ],
  edges: [{ id: "e", source: "start", target: "end" }],
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  defaultExecutionMode: "oneshot",
  enabled: true,
  trigger: {
    type: "statusChange",
    conditions: { toStatus: OCPPStatus.Charging },
  },
};

describe("ScenarioManager.destroy", () => {
  it("releases its connector status listener", () => {
    const connector = new Connector(1, new Logger(LogLevel.ERROR));
    const chargePoint = {
      status: OCPPStatus.Available,
      logger: new Logger(LogLevel.ERROR),
    } as unknown as ChargePoint;
    const before = connector.events.listenerCount("statusChange");
    const manager = new ScenarioManager(
      connector,
      chargePoint,
      createScenarioExecutorCallbacks({ chargePoint, connector }),
    );
    manager.loadScenarios([triggered]);
    expect(connector.events.listenerCount("statusChange")).toBe(before + 1);

    manager.destroy();

    // A destroyed (e.g. replaced) manager must not stay subscribed to the
    // connector for the connector's whole lifetime.
    expect(connector.events.listenerCount("statusChange")).toBe(before);
  });
});
