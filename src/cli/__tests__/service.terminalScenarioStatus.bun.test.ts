import { describe, expect, it } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * `scenario_status` used to go null the moment a run ended, because
 * getScenarioStatus read only the live-executor map and runScenario's finally
 * deletes from it. A client polling for `state === "completed"` therefore never
 * succeeded, and could not tell "unknown scenarioId" from "already finished" --
 * even though the run was still sitting in scenario_report.
 *
 * Terminal status now survives until the scenario is removed, and it agrees with
 * the report's executionState so the two surfaces never disagree.
 */
function newService(): CLIChargePointService {
  return new CLIChargePointService(
    {
      cpId: "cp-terminal-status",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    BunSqliteDatabase.open(":memory:"),
  );
}

/** start → end: completes immediately, no transport needed. */
function completingScenario(id = "completes"): ScenarioDefinition {
  return {
    id,
    name: id,
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

/** start → long delay → end: stays running so it can be stopped mid-flight. */
function blockingScenario(id = "blocks"): ScenarioDefinition {
  const def = completingScenario(id);
  return {
    ...def,
    nodes: [
      def.nodes[0],
      {
        id: "d",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 1 },
        data: { label: "wait", delaySeconds: 600 },
      },
      def.nodes[1],
    ],
    edges: [
      { id: "e1", source: "s", target: "d" },
      { id: "e2", source: "d", target: "e" },
    ],
  } as ScenarioDefinition;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("scenario_status keeps a terminal state after the run ends", () => {
  it("reports completed + runId once a run finishes", async () => {
    const service = newService();
    const id = service.loadScenario(1, completingScenario());
    service.runScenario(1, id);

    const running = service.getScenarioStatus(1, id);
    expect(running).not.toBeNull();
    const runningRunId = running!.runId;
    expect(runningRunId).toBeTruthy();

    await settle();

    const terminal = service.getScenarioStatus(1, id);
    expect(terminal).not.toBeNull();
    expect(terminal!.state).toBe("completed");
    expect(terminal!.runId).toBe(runningRunId!);
    expect(terminal!.scenarioId).toBe(id);
    // The run is over, so nothing is parked.
    expect(terminal!.expectation ?? null).toBeNull();
  });

  it("agrees with the report's executionState", async () => {
    const service = newService();
    const id = service.loadScenario(1, completingScenario());
    service.runScenario(1, id);
    await settle();

    const status = service.getScenarioStatus(1, id);
    const report = service.getScenarioReport(1, id);
    expect(report).not.toBeNull();
    expect(status!.runId).toBe(report!.runId);
    expect(status!.state).toBe(report!.executionState);
  });

  it("still returns null for a scenario id that was never loaded", () => {
    const service = newService();
    expect(service.getScenarioStatus(1, "never-loaded")).toBeNull();
  });

  it("drops the terminal state when the scenario is removed", async () => {
    const service = newService();
    const id = service.loadScenario(1, completingScenario());
    service.runScenario(1, id);
    await settle();
    expect(service.getScenarioStatus(1, id)).not.toBeNull();

    expect(service.removeScenario(1, id)).toBe(true);
    expect(service.getScenarioStatus(1, id)).toBeNull();
  });

  it("reports a terminal state after a manual stop too", async () => {
    const service = newService();
    const id = service.loadScenario(1, blockingScenario());
    service.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.getScenarioStatus(1, id)!.state).not.toBe("completed");

    service.stopScenario(1, id);
    await settle();

    const terminal = service.getScenarioStatus(1, id);
    expect(terminal).not.toBeNull();
    expect(["completed", "error"]).toContain(terminal!.state);
    expect(terminal!.runId).toBeTruthy();
    expect(terminal!.runId).toBe(service.getScenarioReport(1, id)!.runId);
  });

  it("replaces the terminal state with live status on a re-run", async () => {
    const service = newService();
    const id = service.loadScenario(1, completingScenario());
    service.runScenario(1, id);
    await settle();
    const firstRunId = service.getScenarioStatus(1, id)!.runId;

    service.runScenario(1, id);
    await settle();
    const secondRunId = service.getScenarioStatus(1, id)!.runId;

    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(firstRunId);
    expect(service.getScenarioStatus(1, id)!.state).toBe("completed");
  });
});

describe("list_scenarios exposes the id, state and mode", () => {
  it("includes scenarioId, name, active, state and mode", async () => {
    const service = newService();
    const id = service.loadScenario(1, completingScenario("listed"));

    // Never run: no state yet, and definitely no crash.
    const before = service.listScenarios(1);
    expect(before).toHaveLength(1);
    expect(before[0].scenarioId).toBe("listed");
    expect(before[0].name).toBe("listed");
    expect(before[0].active).toBe(false);
    expect(before[0].state ?? null).toBeNull();

    service.runScenario(1, id);
    await settle();

    const after = service.listScenarios(1);
    expect(after[0].active).toBe(false);
    expect(after[0].state).toBe("completed");
    expect(after[0].mode).toBe("oneshot");
  });

  it("reports the live state while a scenario is running", async () => {
    const service = newService();
    const id = service.loadScenario(1, blockingScenario("running-one"));
    service.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 20));

    const entry = service.listScenarios(1).find((s) => s.scenarioId === id)!;
    expect(entry.active).toBe(true);
    expect(entry.state).not.toBeNull();
    expect(entry.state).not.toBe("completed");

    service.stopScenario(1, id);
  });
});
