import { describe, it, expect } from "vitest";
import { Connector } from "../../../domain/connector/Connector";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ScenarioManager } from "../ScenarioManager";
import { ScenarioDefinition, ScenarioNodeType } from "../ScenarioTypes";
import {
  defaultEVSettings,
  type EVSettings,
} from "../../../domain/connector/EVSettings";

function makeConnector(): Connector {
  // ERROR-level logger so tests stay quiet without overriding stdout.
  return new Connector(1, new Logger(LogLevel.ERROR));
}

// A ScenarioManager only needs `status` (gate for executeScenario) and
// `logger` (scenario execution logging) from its ChargePoint — the rest of
// the callbacks this scenario exercises (onSetEVSettings, onWaitForStatus)
// operate on the connector directly.
function makeChargePointStub(): ChargePoint {
  return {
    status: OCPPStatus.Available,
    logger: new Logger(LogLevel.ERROR),
  } as unknown as ChargePoint;
}

// Start -> wait indefinitely for a status this test never reaches -> End.
// Declares `evSettings`, which ScenarioExecutor applies via onSetEVSettings
// before the first node runs, and then stays "running" (paused on the wait)
// so we can exercise default-propagation-while-active before stopping it.
function scenarioWithEvSettingsOverride(
  evSettings: Partial<EVSettings>,
): ScenarioDefinition {
  return {
    id: "sc-ev-override",
    name: "ev override test",
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
        data: {
          label: "Wait",
          targetStatus: OCPPStatus.Charging,
          timeout: 0,
        },
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
    evSettings,
  };
}

// Start -> End: runs to natural completion immediately. Only carries
// `evSettings` when the caller provides them, so tests cover both a
// scenario that owns an EV settings override and one that never touches
// EV settings at all.
function completingScenario(
  id: string,
  evSettings?: Partial<EVSettings>,
): ScenarioDefinition {
  return {
    id,
    name: `completing ${id}`,
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
        position: { x: 0, y: 100 },
        data: { label: "End" },
      },
    ],
    edges: [{ id: "e-start", source: "start", target: "end" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
    ...(evSettings ? { evSettings } : {}),
  };
}

describe("ScenarioManager EV settings override (#105)", () => {
  it("keeps a running scenario's evSettings override across a default propagation, and clears it on stop", async () => {
    const connector = makeConnector();
    const chargePoint = makeChargePointStub();
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const manager = new ScenarioManager(connector, chargePoint, callbacks);

    const scenarioOverride: Partial<EVSettings> = { targetSoc: 50 };
    const scenario = scenarioWithEvSettingsOverride(scenarioOverride);
    manager.loadScenarios([scenario]);

    // Fire-and-forget: the scenario parks indefinitely on the STATUS_TRIGGER
    // wait node (never reaches Charging), so this promise doesn't resolve
    // until we stop the scenario below.
    void manager.executeScenario(scenario.id);

    // Let the microtask queue settle so the START node runs and
    // onSetEVSettings applies the scenario's evSettings.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connector.evSettings.targetSoc).toBe(50);

    // Simulate a Default EV Settings propagation while the scenario is
    // still active (e.g. a browser reload re-pushing the default in remote
    // mode, #107) — the override must win.
    connector.applyDefaultEvSettings({ ...defaultEVSettings, targetSoc: 80 });
    expect(connector.evSettings.targetSoc).toBe(50);

    manager.stopScenario(scenario.id);

    // Override cleared: the next default propagation is free to apply.
    connector.applyDefaultEvSettings({ ...defaultEVSettings, targetSoc: 80 });
    expect(connector.evSettings.targetSoc).toBe(80);
  });

  it("does not release an explicit override when a scenario WITHOUT evSettings completes", async () => {
    const connector = makeConnector();
    const chargePoint = makeChargePointStub();
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const manager = new ScenarioManager(connector, chargePoint, callbacks);

    // Explicit (set_ev_settings-style) override, independent of any scenario.
    connector.applyEvSettingsOverride({ targetSoc: 50 });

    // A scenario that never touches EV settings runs to natural completion
    // on the same connector (e.g. a status auto-trigger scenario).
    const scenario = completingScenario("sc-no-ev");
    manager.loadScenarios([scenario]);
    await manager.executeScenario(scenario.id);

    // The scenario must not have released the explicit override: a default
    // propagation afterwards still no-ops.
    connector.applyDefaultEvSettings({ ...defaultEVSettings, targetSoc: 80 });
    expect(connector.evSettings.targetSoc).toBe(50);
  });

  it("releases the override when a scenario WITH evSettings completes naturally", async () => {
    const connector = makeConnector();
    const chargePoint = makeChargePointStub();
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const manager = new ScenarioManager(connector, chargePoint, callbacks);

    const scenario = completingScenario("sc-with-ev", { targetSoc: 50 });
    manager.loadScenarios([scenario]);
    await manager.executeScenario(scenario.id);

    expect(connector.evSettings.targetSoc).toBe(50);

    // The scenario owned the override and completed — the next default
    // propagation applies again.
    connector.applyDefaultEvSettings({ ...defaultEVSettings, targetSoc: 80 });
    expect(connector.evSettings.targetSoc).toBe(80);
  });
});
