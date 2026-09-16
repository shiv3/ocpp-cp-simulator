// Runs under `bun test`: the registry path pulls in the `bun:sqlite` built-in.
import { describe, it, expect } from "bun:test";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import type { CLIChargePointService } from "../../service";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";

/**
 * #318 / #352, at the RPC implementation's level.
 *
 * Every `cert16-*` template starts on `triggerOn: "connect"`. Loading one onto
 * an Available charge point runs the auto-start gate, so the instance was
 * already running when `run_scenario_template`'s own explicit start ran, and
 * the RPC failed with "already running" for a scenario it had in fact loaded
 * and started (#318). The load now suppresses the gate, the way
 * `run_scenario_file` has since #314, and `once: true` loads the instance
 * disabled so the walker never re-arms it on a later reconnect (#352).
 *
 * The trap the issue names: `cp.create` seeds "Essential CP Behavior", which
 * auto-starts on connect and owns the connector's auto-start slot, so a test
 * that leaves it in place never reaches the template's own start and passes
 * with the bug present. The seeded scenarios are removed first, and a control
 * row shows the gate really does start a template loaded the default way.
 */
const TEMPLATE = "cert16-tc001-cold-boot";

function harness() {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const deps = createRuntimeDeps({ registry, bus, database: null });
  const svc = registry.create({
    cpId: "cp-318",
    wsUrl: "ws://127.0.0.1:65534/never",
    connectors: 1,
    vendor: "v",
    model: "m",
    basicAuth: null,
  });
  // Clear the seeded default so the template's own start is reachable.
  for (const item of svc.listScenarios(1)) {
    svc.removeScenario(1, item.scenarioId);
  }
  // The gate only fires on an Available charge point — the daemon's resting
  // state once the CSMS has accepted the boot.
  (svc as unknown as { _chargePoint: { status: string } })._chargePoint.status =
    "Available";
  return { registry, cps: deps.chargePointService, svc };
}

function definitionOf(
  svc: CLIChargePointService,
  scenarioId: string,
): ScenarioDefinition | undefined {
  return (
    svc as unknown as {
      _scenarios: Map<string, { definition: ScenarioDefinition }>;
    }
  )._scenarios.get(scenarioId)?.definition;
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

describe("run_scenario_template on an Available charge point (#318, #352)", () => {
  it("control: the default load path auto-starts a connect-triggered template", () => {
    const { registry, svc } = harness();
    try {
      const id = svc.loadScenarioTemplate(TEMPLATE, 1);
      expect(svc.isScenarioRunning(id)).toBe(true);
    } finally {
      registry.shutdownAll();
    }
  });

  it("succeeds instead of failing with 'already running', and the run is the one it started", async () => {
    const { registry, cps, svc } = harness();
    try {
      const { scenarioId } = await cps.runScenarioTemplate("cp-318", TEMPLATE, {
        connectorId: 1,
        strict: true,
      });
      expect(svc.isScenarioRunning(scenarioId)).toBe(true);
      expect(definitionOf(svc, scenarioId)?.enabled).not.toBe(false);
    } finally {
      registry.shutdownAll();
    }
  });

  it("without `once` the instance re-arms on the next connect (#253 default)", async () => {
    const { registry, cps, svc } = harness();
    try {
      const { scenarioId } = await cps.runScenarioTemplate("cp-318", TEMPLATE, {
        connectorId: 1,
      });
      svc.stopScenario(1, scenarioId);
      expect(svc.isScenarioRunning(scenarioId)).toBe(false);
      fireConnectGate(svc);
      expect(svc.isScenarioRunning(scenarioId)).toBe(true);
    } finally {
      registry.shutdownAll();
    }
  });

  it("with `once: true` the instance is loaded disabled and does not re-arm", async () => {
    const { registry, cps, svc } = harness();
    try {
      const { scenarioId } = await cps.runScenarioTemplate("cp-318", TEMPLATE, {
        connectorId: 1,
        once: true,
      });
      expect(svc.isScenarioRunning(scenarioId)).toBe(true);
      expect(definitionOf(svc, scenarioId)?.enabled).toBe(false);
      svc.stopScenario(1, scenarioId);
      fireConnectGate(svc);
      expect(svc.isScenarioRunning(scenarioId)).toBe(false);
    } finally {
      registry.shutdownAll();
    }
  });
});
