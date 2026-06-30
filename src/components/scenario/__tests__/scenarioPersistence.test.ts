import { describe, expect, it, vi } from "vitest";
import {
  persistEditorScenario,
  retargetScenarioToConnector,
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
