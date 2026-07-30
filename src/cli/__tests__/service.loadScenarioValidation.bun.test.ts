import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * `loadScenario` used to store whatever it was handed and return
 * `definition.id` unchecked. An inline definition missing `id` was therefore
 * accepted: it landed in the runtime map under the key `undefined`, the RPC
 * result serialised to `{}` instead of `{ scenarioId }`, and `list_scenarios`
 * grew an entry with a name but no id — un-runnable and un-removable garbage
 * that also persisted to state.db.
 *
 * Required fields match the published schema's required set
 * (schema/scenario.schema.json). The full-schema check stays advisory
 * (issue #214): only these load-bearing fields hard-fail, so files written
 * before that schema existed still load.
 */
function newService(): CLIChargePointService {
  return new CLIChargePointService(
    {
      cpId: "cp-load-validation",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    BunSqliteDatabase.open(":memory:"),
  );
}

function validScenario(): ScenarioDefinition {
  return {
    id: "valid-scenario",
    name: "Valid",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    enabled: true,
    nodes: [
      {
        id: "s",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "e",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 1 },
        data: { label: "E" },
      },
    ],
    edges: [{ id: "e1", source: "s", target: "e" }],
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  } as ScenarioDefinition;
}

/** Drop a field, the way a hand-written RPC payload would. */
function without(field: string): ScenarioDefinition {
  const def = validScenario() as unknown as Record<string, unknown>;
  delete def[field];
  return def as unknown as ScenarioDefinition;
}

describe("loadScenario rejects definitions missing required fields", () => {
  it("accepts a complete definition and returns its id", () => {
    const service = newService();
    expect(service.loadScenario(1, validScenario())).toBe("valid-scenario");
    expect(service.listScenarios(1).map((s) => s.scenarioId)).toEqual([
      "valid-scenario",
    ]);
  });

  for (const field of ["id", "name", "targetType", "nodes", "edges"]) {
    it(`rejects a definition with no "${field}"`, () => {
      const service = newService();
      expect(() => service.loadScenario(1, without(field))).toThrow(field);
      // Nothing half-loaded: no runtime entry to leak into list_scenarios.
      expect(service.listScenarios(1)).toEqual([]);
    });
  }

  it("rejects an empty id rather than storing an unaddressable scenario", () => {
    const service = newService();
    const def = validScenario();
    (def as { id: string }).id = "   ";
    expect(() => service.loadScenario(1, def)).toThrow("id");
    expect(service.listScenarios(1)).toEqual([]);
  });

  it("rejects a bad targetType and a non-array nodes/edges", () => {
    const service = newService();
    const badTarget = validScenario() as unknown as Record<string, unknown>;
    badTarget.targetType = "station";
    expect(() =>
      service.loadScenario(1, badTarget as unknown as ScenarioDefinition),
    ).toThrow("targetType");

    const badNodes = validScenario() as unknown as Record<string, unknown>;
    badNodes.nodes = { 0: "not-an-array" };
    expect(() =>
      service.loadScenario(1, badNodes as unknown as ScenarioDefinition),
    ).toThrow("nodes");

    expect(service.listScenarios(1)).toEqual([]);
  });

  it("rejects a non-object payload without throwing a TypeError", () => {
    const service = newService();
    for (const bad of [null, undefined, "scenario", 42, []]) {
      expect(() =>
        service.loadScenario(1, bad as unknown as ScenarioDefinition),
      ).toThrow(/scenario/i);
    }
    expect(service.listScenarios(1)).toEqual([]);
  });

  it("still reports an unknown connector, not a validation error", () => {
    const service = newService();
    expect(() => service.loadScenario(99, validScenario())).toThrow(
      "Connector 99 not found",
    );
  });
});
