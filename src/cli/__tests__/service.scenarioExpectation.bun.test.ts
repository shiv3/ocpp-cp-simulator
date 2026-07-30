import { describe, it, expect } from "bun:test";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase as BunDb } from "../../cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "../../cp/domain/persistence/schema";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * #179 Phase 1: a scenario parked on a CSMS-call trigger must report
 * state:"waiting" with a normalized expectation, and every lifecycle event
 * (plus the status) must carry a stable runId.
 */
function parkingScenario(connectorId: number): ScenarioDefinition {
  return {
    id: `expectation-${connectorId}-fixed`,
    name: "Park on GetConfiguration",
    targetType: "connector",
    targetId: connectorId,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "wait-cfg",
        type: ScenarioNodeType.CSMS_CALL_TRIGGER,
        position: { x: 0, y: 1 },
        // timeout 0 = park forever; the CALL never arrives in this test.
        data: {
          label: "Wait GetConfiguration",
          action: "GetConfiguration",
          timeout: 0,
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "wait-cfg" },
      { id: "e2", source: "wait-cfg", target: "end-1" },
    ],
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
  };
}

function newService(): CLIChargePointService {
  const raw = new BunSqliteDatabase(":memory:");
  const db = new BunDb(raw);
  runMigrations(db);
  return new CLIChargePointService(
    {
      cpId: "test-cp",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
    },
    db,
  );
}

describe("#179 Phase 1: scenario expectation + runId", () => {
  it("reports waiting + expectation and threads a runId through status and events", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, parkingScenario(1));

    let startedRunId: string | undefined;
    svc.onEvent((ev) => {
      if (ev.event === "scenario_started") {
        startedRunId = ev.data.runId;
      }
    });

    svc.runScenario(1, id);
    // Let the executor walk start → park on the csmsCallTrigger.
    await new Promise((r) => setTimeout(r, 300));

    const status = svc.getScenarioStatus(1, id);
    expect(status).not.toBeNull();
    expect(status!.state).toBe("waiting");
    expect(status!.currentNodeId).toBe("wait-cfg");
    expect(status!.expectation).toMatchObject({
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "GetConfiguration",
      nodeId: "wait-cfg",
    });

    // runId is stable and shared between the started event and the status.
    expect(typeof startedRunId).toBe("string");
    expect(startedRunId).toContain(`${id}#`);
    expect(status!.runId).toBe(startedRunId);

    // Cleanup: stop the parked scenario.
    svc.stopScenario(1, id);
    await new Promise((r) => setTimeout(r, 50));
  });

  it("clears the expectation and reports a terminal status after the run is stopped", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, parkingScenario(1));
    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 300));

    expect(svc.getScenarioStatus(1, id)!.state).toBe("waiting");

    svc.stopScenario(1, id);
    await new Promise((r) => setTimeout(r, 50));

    // The executor is gone, but status must not disappear with it: a poller
    // waiting for the run to end has to be able to observe that it did. What
    // must NOT survive is the stale "waiting" state and its expectation.
    const status = svc.getScenarioStatus(1, id);
    expect(status).not.toBeNull();
    expect(status!.state).not.toBe("waiting");
    expect(status!.expectation ?? null).toBeNull();
    expect(status!.runId).toBeTruthy();

    // Removing the scenario is what finally clears it.
    expect(svc.removeScenario(1, id)).toBe(true);
    expect(svc.getScenarioStatus(1, id)).toBeNull();
  });
});
