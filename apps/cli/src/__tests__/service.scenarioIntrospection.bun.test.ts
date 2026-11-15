import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { summarizeScenarios } from "@ocpp-cp-simulator/core/cp/application/diagnostics/scenarioReadModel";
import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { testCpInit } from "./testCpInit";

// #925 / #927: the daemon's scenario read model (what GetConfiguration, the 2.x
// SimulatorCtrlr variables and the diagnostic bundle read): installed scenarios,
// runs in progress, the last finished run, never a historical run as active.
function newService(): { service: CLIChargePointService; cp: ChargePoint } {
  const service = new CLIChargePointService(
    testCpInit({ cpId: "cp-introspection", connectors: 2 }),
    BunSqliteDatabase.open(":memory:"),
  );
  const cp = (service as unknown as { _chargePoint: ChargePoint })._chargePoint;
  return { service, cp };
}

function scenario(
  id: string,
  connectorId: number,
  delaySeconds?: number,
): ScenarioDefinition {
  const nodes: unknown[] = [
    {
      id: "s",
      type: ScenarioNodeType.START,
      position: { x: 0, y: 0 },
      data: { label: "S" },
    },
    ...(delaySeconds
      ? [
          {
            id: "d",
            type: ScenarioNodeType.DELAY,
            position: { x: 0, y: 1 },
            data: { label: "wait", delaySeconds },
          },
        ]
      : []),
    {
      id: "e",
      type: ScenarioNodeType.END,
      position: { x: 0, y: 2 },
      data: { label: "E" },
    },
  ];
  const ids = nodes.map((n) => (n as { id: string }).id);
  return {
    id,
    name: `name-${id}`,
    targetType: "connector",
    targetId: connectorId,
    trigger: { type: "manual" },
    enabled: true,
    nodes,
    edges: ids.slice(1).map((target, i) => ({
      id: `e${i}`,
      source: ids[i],
      target,
    })),
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  } as ScenarioDefinition;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

describe("daemon scenario introspection", () => {
  it("is idle with nothing installed", () => {
    const { cp } = newService();
    const s = summarizeScenarios(cp.diagnosticsSources.scenarios);
    expect(s).toMatchObject({
      status: "idle",
      installedCount: 0,
      lastRun: null,
    });
    expect(s.runs).toEqual([]);
    expect(cp.diagnosticsSources.simulatorVersion).toBeTruthy();
  });

  it("one running scenario, then two on two connectors (multiple), then idle with a last run", async () => {
    const { service, cp } = newService();
    const a = service.loadScenario(1, scenario("a", 1, 600));
    const b = service.loadScenario(2, scenario("b", 2, 600));
    const read = () => summarizeScenarios(cp.diagnosticsSources.scenarios);
    expect(read()).toMatchObject({ status: "idle", installedCount: 2 });

    service.runScenario(1, a);
    await settle();
    let s = read();
    expect(s.runs).toHaveLength(1);
    expect(["running", "waiting"]).toContain(s.status);
    expect(s.runs[0]).toMatchObject({ scenarioId: a, connectorId: 1 });
    expect(s.runs[0]!.runId).toBeTruthy();
    expect(s.lastRun).toBeNull();

    service.runScenario(2, b);
    await settle();
    s = read();
    expect(s.status).toBe("multiple");
    expect(s.runs.map((r) => r.connectorId)).toEqual([1, 2]);

    service.stopScenario(1, a);
    service.stopScenario(2, b);
    await settle();
    s = read();
    expect(s.status).toBe("idle");
    expect(s.runs).toEqual([]);
    // A finished run is only ever `lastRun`, never active.
    expect(s.lastRun).toMatchObject({ outcome: "stopped" });
    expect([a, b]).toContain(s.lastRun!.scenarioId);
  });

  it("a scenario that finishes on its own is a passed last run", async () => {
    const { service, cp } = newService();
    const id = service.loadScenario(1, scenario("quick", 1));
    service.runScenario(1, id);
    await settle();
    const s = summarizeScenarios(cp.diagnosticsSources.scenarios);
    expect(s.status).toBe("idle");
    expect(s.lastRun).toMatchObject({ scenarioId: id, connectorId: 1 });
    expect(["passed", "failed", "error"]).toContain(s.lastRun!.outcome);
  });
});
