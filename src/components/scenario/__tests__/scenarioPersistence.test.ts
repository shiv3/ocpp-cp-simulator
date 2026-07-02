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

function makeService(existingIds: string[] = []) {
  return {
    listScenarios: vi
      .fn()
      .mockResolvedValue(existingIds.map((scenarioId) => ({ scenarioId }))),
    removeScenario: vi.fn().mockResolvedValue(undefined),
    loadScenario: vi.fn().mockResolvedValue({ scenarioId: "x" }),
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

describe("persistEditorScenario (scenario upload / template persistence — #101)", () => {
  it("remote mode pushes the scenario to the daemon (not the no-op sql.js repo)", async () => {
    const chargePointService = makeService([]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
    const uploaded = scenario("new-1");

    await persistEditorScenario(
      {
        mode: "remote",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 1,
      },
      uploaded,
    );

    // The bug: upload only called scenarioRepository.save, a no-op in remote
    // mode, so the upload vanished on reload. It must reach the daemon.
    expect(chargePointService.loadScenario).toHaveBeenCalledWith(
      "CP1",
      1,
      uploaded,
    );
    expect(scenarioRepository.save).not.toHaveBeenCalled();
  });

  it("serializes the graph before remote persistence", async () => {
    const chargePointService = makeService([]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
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
        mode: "remote",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 1,
      },
      uploaded,
    );

    const persisted = chargePointService.loadScenario.mock.calls[0][2];
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
  });

  it("remote mode removes stale prior scenarios but keeps the one being saved", async () => {
    const chargePointService = makeService(["old-a", "old-b", "new-1"]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };

    await persistEditorScenario(
      {
        mode: "remote",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 2,
      },
      scenario("new-1"),
    );

    expect(chargePointService.removeScenario).toHaveBeenCalledWith(
      "CP1",
      2,
      "old-a",
    );
    expect(chargePointService.removeScenario).toHaveBeenCalledWith(
      "CP1",
      2,
      "old-b",
    );
    // The incoming scenario id must NOT be removed.
    expect(chargePointService.removeScenario).not.toHaveBeenCalledWith(
      "CP1",
      2,
      "new-1",
    );
    expect(chargePointService.removeScenario).toHaveBeenCalledTimes(2);
  });

  it("remote mode still saves when a stale removal fails", async () => {
    const chargePointService = makeService(["old-a"]);
    chargePointService.removeScenario.mockRejectedValueOnce(new Error("boom"));
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
    const uploaded = scenario("new-1");

    await expect(
      persistEditorScenario(
        {
          mode: "remote",
          chargePointService,
          scenarioRepository,
          cpId: "CP1",
          connectorId: 1,
        },
        uploaded,
      ),
    ).resolves.toBeUndefined();

    expect(chargePointService.loadScenario).toHaveBeenCalledWith(
      "CP1",
      1,
      uploaded,
    );
  });

  it("local mode upserts into the sql.js repository and never touches the daemon", async () => {
    const chargePointService = makeService(["old-a"]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
    const uploaded = scenario("new-1");

    await persistEditorScenario(
      {
        mode: "local",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 1,
      },
      uploaded,
    );

    expect(scenarioRepository.save).toHaveBeenCalledWith("CP1", 1, uploaded);
    expect(chargePointService.listScenarios).not.toHaveBeenCalled();
    expect(chargePointService.removeScenario).not.toHaveBeenCalled();
    expect(chargePointService.loadScenario).not.toHaveBeenCalled();
  });
});

describe("saveEditorScenario (editor autosave / manual save upsert)", () => {
  it("remote mode upserts through daemon loadScenario without pruning siblings", async () => {
    const chargePointService = makeService(["old-a"]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
    const edited = scenario("edited-1");

    await saveEditorScenario(
      {
        mode: "remote",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    expect(chargePointService.loadScenario).toHaveBeenCalledWith(
      "CP1",
      1,
      edited,
    );
    expect(chargePointService.listScenarios).not.toHaveBeenCalled();
    expect(chargePointService.removeScenario).not.toHaveBeenCalled();
    expect(scenarioRepository.save).not.toHaveBeenCalled();
  });

  it("local mode upserts through the repository without touching daemon scenario APIs", async () => {
    const chargePointService = makeService(["old-a"]);
    const scenarioRepository = { save: vi.fn().mockResolvedValue(undefined) };
    const edited = scenario("edited-1");

    await saveEditorScenario(
      {
        mode: "local",
        chargePointService,
        scenarioRepository,
        cpId: "CP1",
        connectorId: 1,
      },
      edited,
    );

    expect(scenarioRepository.save).toHaveBeenCalledWith("CP1", 1, edited);
    expect(chargePointService.listScenarios).not.toHaveBeenCalled();
    expect(chargePointService.removeScenario).not.toHaveBeenCalled();
    expect(chargePointService.loadScenario).not.toHaveBeenCalled();
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

  it("lets an even newer queued save supersede an older queued save", async () => {
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
    const saveC = saveLatest("C");

    gates[0].resolve();
    await saveA;
    await saveB;
    await flushPromises();

    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(saveFn).toHaveBeenNthCalledWith(1, "A");
    expect(saveFn).toHaveBeenNthCalledWith(2, "C");
    expect(saveFn).not.toHaveBeenCalledWith("B");

    gates[1].resolve();
    await saveC;
    expect(persisted).toEqual(["A", "C"]);
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
    // Content is preserved; only targeting/timestamp change.
    expect(out.id).toBe("up-1");
    expect(out.nodes).toBe(fromConnector1.nodes);
  });

  it("targets the charge point when connectorId is null", () => {
    const out = retargetScenarioToConnector(scenario("up-2"), null, now);
    expect(out.targetType).toBe("chargePoint");
    expect(out.targetId).toBeUndefined();
  });
});
