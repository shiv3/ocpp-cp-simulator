import { describe, expect, it, vi } from "vitest";
import {
  createLatestWinsSaver,
  persistEditorScenario,
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
      replaceConnectorScenarioDefinitions: vi.fn(
        async (
          _cpId: string,
          _connectorId: number | null,
          definitions: readonly ScenarioDefinition[],
        ) => {
          stored = [...definitions];
          return stored;
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

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  const value = {} as Deferred;
  value.promise = new Promise<void>((resolve, reject) => {
    value.resolve = () => resolve();
    value.reject = (error: Error) => reject(error);
  });
  return value;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("persistEditorScenario (scenario upload / template replace persistence — #101)", () => {
  it("replaces the connector definition set with the uploaded scenario through the service port", async () => {
    const stale = scenario("old-a");
    const keep = scenario("new-1");
    const chargePointService = makeService([stale, keep]);
    const uploaded = scenario("new-1");

    await persistEditorScenario(
      {
        mode: "local",
        chargePointService,
        cpId: "CP1",
        connectorId: 1,
      },
      uploaded,
    );

    expect(chargePointService.listScenarioDefinitions).toHaveBeenCalledWith(
      "CP1",
      1,
    );
    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).toHaveBeenCalledWith("CP1", 1, [uploaded]);
    expect(chargePointService.saveScenarioDefinition).not.toHaveBeenCalled();
    expect(chargePointService.loadScenario).not.toHaveBeenCalled();
  });

  it("serializes the graph before replace persistence", async () => {
    const chargePointService = makeService([]);
    const uploaded = {
      ...scenario("new-1"),
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

    await persistEditorScenario(
      {
        mode: "local",
        chargePointService,
        cpId: "CP1",
        connectorId: 1,
      },
      uploaded,
    );

    const persisted =
      chargePointService.replaceConnectorScenarioDefinitions.mock
        .calls[0][2][0];
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

  it("persists and activates the remote runtime after autosave replace", async () => {
    const stale = scenario("stale");
    const edited = scenario("edited");
    const remote = makeRemoteStyleService([stale]);

    await persistEditorScenario(
      {
        mode: "remote",
        chargePointService: remote.service,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    expect(
      remote.service.replaceConnectorScenarioDefinitions,
    ).toHaveBeenCalledWith("CP1", 1, [edited]);
    expect(remote.service.loadScenario).toHaveBeenCalledWith("CP1", 1, edited);
    expect(remote.getStored()).toEqual([edited]);
    expect(remote.getActive()).toEqual(edited);
  });
});

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

describe("createLatestWinsSaver", () => {
  it("saves a queued newer payload after the in-flight save", async () => {
    const gates: Deferred[] = [];
    const persisted: string[] = [];
    const saveFn = vi.fn((payload: string) => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise.then(() => {
        persisted.push(payload);
      });
    });
    const saveLatest = createLatestWinsSaver(saveFn);

    const saveA = saveLatest("A");
    await flushPromises();
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenLastCalledWith("A");

    const saveB = saveLatest("B");
    expect(saveFn).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await saveA;
    await flushPromises();
    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(saveFn).toHaveBeenLastCalledWith("B");

    gates[1].resolve();
    await saveB;
    expect(persisted).toEqual(["A", "B"]);
  });

  it("lets an even newer queued replace supersede an older queued replace", async () => {
    const gates: Deferred[] = [];
    const chargePointService = makeService([]);
    chargePointService.replaceConnectorScenarioDefinitions.mockImplementation(
      async () => {
        const gate = deferred();
        gates.push(gate);
        return gate.promise.then(() => []);
      },
    );
    const saveLatest = createLatestWinsSaver<ScenarioDefinition>((definition) =>
      persistEditorScenario(
        {
          mode: "local",
          chargePointService,
          cpId: "CP1",
          connectorId: 1,
        },
        definition,
      ),
    );

    const saveA = saveLatest(scenario("A"));
    await flushPromises();
    const saveB = saveLatest(scenario("B"));
    const saveC = saveLatest(scenario("C"));

    gates[0].resolve();
    await saveA;
    await saveB;
    await flushPromises();

    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).toHaveBeenCalledTimes(2);
    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).toHaveBeenNthCalledWith(1, "CP1", 1, [scenario("A")]);
    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).toHaveBeenLastCalledWith("CP1", 1, [scenario("C")]);
    expect(
      chargePointService.replaceConnectorScenarioDefinitions,
    ).not.toHaveBeenCalledWith("CP1", 1, [scenario("B")]);

    gates[1].resolve();
    await saveC;
  });

  it("continues with the latest queued save after an in-flight failure", async () => {
    const gates: Deferred[] = [];
    const persisted: string[] = [];
    const saveFn = vi.fn((payload: string) => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise.then(() => {
        persisted.push(payload);
      });
    });
    const saveLatest = createLatestWinsSaver(saveFn);

    const saveA = saveLatest("A");
    await flushPromises();
    const saveB = saveLatest("B");

    gates[0].reject(new Error("A failed"));
    await expect(saveA).rejects.toThrow("A failed");
    await flushPromises();
    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(saveFn).toHaveBeenLastCalledWith("B");

    gates[1].resolve();
    await saveB;
    expect(persisted).toEqual(["B"]);
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
});
