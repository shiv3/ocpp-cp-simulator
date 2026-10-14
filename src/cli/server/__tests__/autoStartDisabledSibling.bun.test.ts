// Runs under `bun test`: the registry path pulls in the `bun:sqlite` built-in.
import { describe, expect, it } from "bun:test";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import type { CLIChargePointService } from "../../service";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../../cp/application/scenario/ScenarioTypes";

/**
 * A disabled scenario releases only its own auto-start dedup key. Before
 * #411 the walker cleared the connector's key on any disabled definition it
 * met, so a disabled sibling (for instance a `run_scenario_template
 * { once: true }` instance) let an unchanged connect-triggered scenario
 * auto-start again on the next walk.
 */
function definition(id: string, enabled: boolean): ScenarioDefinition {
  return {
    id,
    name: id,
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
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 0 },
        data: { label: "Wait", delaySeconds: 600 },
      },
    ],
    edges: [{ id: "e", source: "start", target: "wait" }],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled,
    trigger: { type: "manual" },
  };
}

function fireConnectGate(svc: CLIChargePointService): void {
  (
    svc as unknown as {
      tryAutoStartForConnector: (
        connectorId: number,
        trigger: "connect",
        status: null,
      ) => void;
    }
  ).tryAutoStartForConnector(1, "connect", null);
}

describe("daemon auto-start dedup with a disabled sibling (#411)", () => {
  it("does not re-fire an unchanged connect scenario", () => {
    const registry = new CPRegistry(new EventBus(), null);
    const svc = registry.create({
      cpId: "cp-disabled-sibling",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    });
    try {
      for (const item of svc.listScenarios(1)) {
        svc.removeScenario(1, item.scenarioId);
      }
      (
        svc as unknown as { _chargePoint: { status: string } }
      )._chargePoint.status = "Available";
      // Walk order: the disabled sibling comes first.
      svc.loadScenario(1, definition("disabled", false), { autoStart: false });
      svc.loadScenario(1, definition("armed", true), { autoStart: false });

      fireConnectGate(svc);
      expect(svc.isScenarioRunning("armed")).toBe(true);
      svc.stopScenario(1, "armed");

      fireConnectGate(svc);
      expect(svc.isScenarioRunning("armed")).toBe(false);
    } finally {
      registry.remove("cp-disabled-sibling");
    }
  });
});
