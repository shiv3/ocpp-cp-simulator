import { describe, it, expect } from "bun:test";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * Unit coverage for CLIChargePointService.syncConnectorRuntimeScenarios — the
 * runtime reconcile that fixes issue #209.
 */
function newService(): CLIChargePointService {
  const db = BunSqliteDatabase.open(":memory:");
  return new CLIChargePointService(
    {
      cpId: "cp-209-unit",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    db,
  );
}

function scenario(
  id: string,
  opts: { delay?: boolean } = {},
): ScenarioDefinition {
  const nodes = [
    {
      id: "s",
      type: ScenarioNodeType.START,
      position: { x: 0, y: 0 },
      data: { label: "S" },
    },
  ];
  if (opts.delay) {
    nodes.push({
      id: "d",
      type: ScenarioNodeType.DELAY,
      position: { x: 0, y: 1 },
      data: { label: "wait", delaySeconds: 60 },
    } as (typeof nodes)[number]);
  }
  nodes.push({
    id: "e",
    type: ScenarioNodeType.END,
    position: { x: 0, y: 2 },
    data: { label: "E" },
  });
  const edges =
    nodes.length === 3
      ? [
          { id: "e1", source: "s", target: "d" },
          { id: "e2", source: "d", target: "e" },
        ]
      : [{ id: "e1", source: "s", target: "e" }];
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    enabled: true,
    nodes,
    edges,
    createdAt: "2026-07-14T00:00:00Z",
    updatedAt: "2026-07-14T00:00:00Z",
  } as ScenarioDefinition;
}

function ids(service: CLIChargePointService): string[] {
  return service.listScenarios(1).map((s) => s.scenarioId);
}

describe("syncConnectorRuntimeScenarios (#209)", () => {
  it("replaces stale runtime entries with the uploaded set", () => {
    const service = newService();
    service.loadScenario(1, scenario("stale"));
    expect(ids(service)).toContain("stale");

    service.syncConnectorRuntimeScenarios(1, [scenario("fresh")]);

    const after = ids(service);
    expect(after).toContain("fresh");
    expect(after).not.toContain("stale");
    service.cleanup();
  });

  it("discards an in-flight run when its connector's definitions are replaced", () => {
    const service = newService();
    const runningId = service.loadScenario(
      1,
      scenario("running", { delay: true }),
    );
    service.runScenario(1, runningId);
    expect(
      service.listScenarios(1).find((s) => s.scenarioId === runningId)?.active,
    ).toBe(true);

    service.syncConnectorRuntimeScenarios(1, [scenario("next")]);

    // The running scenario is gone (executor stopped) and the new one is loaded.
    const after = ids(service);
    expect(after).toEqual(["next"]);
    expect(after).not.toContain(runningId);
    service.cleanup();
  });

  it("is a no-op for a CP-level (null) connector", () => {
    const service = newService();
    service.loadScenario(1, scenario("keep"));
    expect(() =>
      service.syncConnectorRuntimeScenarios(null, [scenario("x")]),
    ).not.toThrow();
    expect(ids(service)).toEqual(["keep"]);
    service.cleanup();
  });
});
