import { describe, expect, it, vi } from "vitest";
import {
  retargetScenarioToConnector,
  saveEditorScenario,
} from "../scenarioPersistence";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";

const scenario = (id: string): ScenarioDefinition =>
  ({
    id,
    name: `Scenario ${id}`,
    nodes: [],
    edges: [],
    trigger: { type: "manual" },
  }) as unknown as ScenarioDefinition;

function makeService(existing: ScenarioDefinition[] = []) {
  return {
    listScenarioDefinitions: vi.fn().mockResolvedValue(existing),
    saveScenarioDefinition: vi.fn().mockResolvedValue(undefined),
    replaceConnectorScenarioDefinitions: vi.fn().mockResolvedValue(undefined),
    loadScenario: vi
      .fn()
      .mockResolvedValue({ scenarioId: existing[0]?.id ?? "" }),
  };
}

function makeRemoteStyleService(existing: ScenarioDefinition[] = []) {
  let stored = [...existing];
  let active: ScenarioDefinition | null = existing[0] ?? null;

  return {
    service: {
      listScenarioDefinitions: vi.fn(async () => stored),
      saveScenarioDefinition: vi.fn(
        async (
          _cpId: string,
          _connectorId: number | null,
          definition: ScenarioDefinition,
        ) => {
          stored = [
            ...stored.filter((item) => item.id !== definition.id),
            definition,
          ];
          return definition;
        },
      ),
      loadScenario: vi.fn(
        async (
          _cpId: string,
          _connectorId: number,
          definition: ScenarioDefinition,
        ) => {
          active =
            stored.find((item) => item.id === definition.id) ?? definition;
          return { scenarioId: definition.id };
        },
      ),
    },
    getStored: () => stored,
    getActive: () => active,
  };
}

describe("saveEditorScenario (single definition upsert)", () => {
  it("upserts through saveScenarioDefinition without pruning siblings", async () => {
    const chargePointService = makeService([scenario("old-a")]);
    const edited = scenario("edited-1");

    await saveEditorScenario(
      {
        mode: "local",
        chargePointService,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    expect(chargePointService.saveScenarioDefinition).toHaveBeenCalledWith(
      "CP1",
      1,
      edited,
    );
    expect(chargePointService.listScenarioDefinitions).not.toHaveBeenCalled();
    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).not.toHaveBeenCalled();
    expect(chargePointService.loadScenario).not.toHaveBeenCalled();
  });

  it("serializes the graph before persisting it", async () => {
    const chargePointService = makeService([]);
    const edited = {
      ...scenario("edited-1"),
      nodes: [
        {
          id: "meter-1",
          type: "meterValue",
          position: { x: 10, y: 20 },
          data: {
            label: "Meter",
            value: 10,
            sendMessage: true,
            progress: { remaining: 1 },
            currentValue: 20,
            style: { border: "1px solid red" },
            className: "executing-node",
          },
          selected: true,
          dragging: true,
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "start",
          target: "meter-1",
          selected: true,
          style: { stroke: "red" },
        },
      ],
    } as unknown as ScenarioDefinition;

    await saveEditorScenario(
      {
        mode: "local",
        chargePointService,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    const persisted =
      chargePointService.saveScenarioDefinition.mock.calls[0][2];
    expect(persisted.nodes[0]).not.toHaveProperty("selected");
    expect(persisted.nodes[0]).not.toHaveProperty("dragging");
    expect(persisted.nodes[0].data).not.toHaveProperty("progress");
    expect(persisted.nodes[0].data).not.toHaveProperty("currentValue");
    expect(persisted.nodes[0].data).not.toHaveProperty("style");
    expect(persisted.nodes[0].data).not.toHaveProperty("className");
    expect(persisted.edges[0]).toEqual({
      id: "edge-1",
      source: "start",
      target: "meter-1",
    });
    expect(chargePointService.loadScenario).not.toHaveBeenCalled();
  });

  it("persists and activates the remote runtime after manual save", async () => {
    const previous = scenario("edited-1");
    const edited = {
      ...scenario("edited-1"),
      name: "Edited name",
    };
    const remote = makeRemoteStyleService([previous]);

    await saveEditorScenario(
      {
        mode: "remote",
        chargePointService: remote.service,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    expect(remote.service.saveScenarioDefinition).toHaveBeenCalledWith(
      "CP1",
      1,
      edited,
    );
    expect(remote.service.loadScenario).toHaveBeenCalledWith("CP1", 1, edited);
    expect(remote.getStored()).toEqual([edited]);
    expect(remote.getActive()).toEqual(edited);
  });
});

describe("retargetScenarioToConnector (upload retargeting — #101)", () => {
  const now = "2026-06-30T00:00:00.000Z";

  it("retargets a file exported from another connector to the current one", () => {
    const fromConnector1 = {
      ...scenario("up-1"),
      targetType: "connector",
      targetId: 1,
    } as unknown as ScenarioDefinition;

    const out = retargetScenarioToConnector(fromConnector1, 2, now);

    expect(out.targetType).toBe("connector");
    expect(out.targetId).toBe(2);
    expect(out.updatedAt).toBe(now);
    expect(out.id).toBe("up-1");
    expect(out.nodes).toBe(fromConnector1.nodes);
  });

  it("targets the charge point when connectorId is null", () => {
    const out = retargetScenarioToConnector(scenario("up-2"), null, now);
    expect(out.targetType).toBe("chargePoint");
    expect(out.targetId).toBeUndefined();
  });

  // #301: every upload path calls this, and both write the result straight to
  // storage — the editor normalized only its own React state and the library
  // path normalized nowhere, so an imported curve reached storage (and any
  // export taken from it) unvalidated.
  it("sorts an uploaded chargingCurve and drops its invalid points", () => {
    const uploaded = {
      ...scenario("up-3"),
      evSettings: {
        initialSoc: 20,
        chargingCurve: [
          { socPercent: 80, powerFraction: 0.4 },
          { socPercent: 10, powerFraction: 1 },
          { socPercent: 150, powerFraction: 1 },
          { socPercent: 50, powerFraction: 9 },
          { socPercent: 30, powerFraction: 0.8 },
        ],
      },
    } as unknown as ScenarioDefinition;

    const out = retargetScenarioToConnector(uploaded, 1, now);

    expect(out.evSettings?.chargingCurve).toEqual([
      { socPercent: 10, powerFraction: 1 },
      { socPercent: 30, powerFraction: 0.8 },
      { socPercent: 80, powerFraction: 0.4 },
    ]);
    // Retargeting still does its own job, and other EV settings are untouched.
    expect(out.targetId).toBe(1);
    expect(out.evSettings?.initialSoc).toBe(20);
  });

  it("leaves a scenario without evSettings without them", () => {
    // Normalizing must not invent an empty object the file never carried.
    const out = retargetScenarioToConnector(scenario("up-4"), 1, now);
    expect("evSettings" in out).toBe(false);
  });
});
