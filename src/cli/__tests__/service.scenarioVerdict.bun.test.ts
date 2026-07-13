import { describe, it, expect } from "bun:test";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase as BunDb } from "../../cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "../../cp/domain/persistence/schema";
import {
  AssertionSpec,
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * #179 Phase 2b: a scenario with no external waits, completing on its own
 * (start -> meterValue -> end) so it finishes without a live CSMS
 * connection. `sendMessage: false` mirrors ScenarioExecutor.context.test.ts's
 * completing-scenario fixture, keeping the run instant.
 */
function completingScenario(
  id: string,
  assertions?: AssertionSpec[],
): ScenarioDefinition {
  return {
    id,
    name: "Completing scenario",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "mv-1",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 1 },
        data: { label: "MV", value: 100, sendMessage: false },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "mv-1" },
      { id: "e2", source: "mv-1", target: "end-1" },
    ],
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
    ...(assertions ? { assertions } : {}),
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

describe("#179 Phase 2b: declarative assertions + verdict + per-run transcript", () => {
  it("getScenarioRunResult is null before any run has finished", () => {
    const svc = newService();
    const id = svc.loadScenario(1, completingScenario("not-run-yet"));
    expect(svc.getScenarioRunResult(id)).toBeNull();
  });

  it("a scenario with no declared assertions produces a SKIPPED verdict (unchanged behavior)", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, completingScenario("no-assertions"));
    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 200));

    const result = svc.getScenarioRunResult(id);
    expect(result).not.toBeNull();
    expect(result!.scenarioId).toBe(id);
    expect(result!.connectorId).toBe(1);
    expect(result!.verdict).toBe("SKIPPED");
    expect(result!.assertions).toEqual([]);
    // #179 Phase 3: the run result is now the full report.
    expect(result!.schemaVersion).toBe(1);
    expect(Array.isArray(result!.transcript)).toBe(true);
    expect(result!.initialState).toBeDefined();
    expect(result!.finalState).toBeDefined();
    expect(typeof result!.durationMs).toBe("number");
    expect(new Date(result!.startedAt).getTime()).toBeLessThanOrEqual(
      new Date(result!.endedAt).getTime(),
    );
  });

  it("an assertion deterministically satisfiable without a live CSMS produces PASS", async () => {
    const svc = newService();
    // This test never calls connect() -- the WebSocket never opens, so the
    // boot gate suppresses every outbound OCPP call and nothing hits the
    // wire. An ocpp_absent assertion for any action is therefore
    // deterministically satisfiable, giving a real end-to-end PASS through
    // the actual service (not a synthetic frame fixture).
    const id = svc.loadScenario(
      1,
      completingScenario("pass-assertion", [
        { id: "no-reset", type: "ocpp_absent", action: "Reset" },
      ]),
    );
    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 200));

    const result = svc.getScenarioRunResult(id);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("PASS");
    expect(result!.assertions).toHaveLength(1);
    expect(result!.assertions[0]).toMatchObject({
      id: "no-reset",
      type: "ocpp_absent",
      status: "passed",
    });
  });

  it("an assertion requiring wire traffic that never happens (no live CSMS) produces FAIL", async () => {
    const svc = newService();
    const id = svc.loadScenario(
      1,
      completingScenario("fail-assertion", [
        { id: "boot-sent", type: "ocpp_sent", action: "BootNotification" },
      ]),
    );
    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 200));

    const result = svc.getScenarioRunResult(id);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("FAIL");
    expect(result!.assertions).toHaveLength(1);
    expect(result!.assertions[0].status).toBe("failed");
  });

  it("resolves a specific runId, and returns null for a mismatched one", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, completingScenario("runid-lookup"));

    let startedRunId: string | undefined;
    svc.onEvent((ev) => {
      if (ev.event === "scenario_started") startedRunId = ev.data.runId;
    });
    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 200));

    expect(typeof startedRunId).toBe("string");
    // Narrow startedRunId to `string` (a `typeof` check inside `expect()`
    // doesn't narrow for TS control-flow analysis) so it type-checks
    // against ScenarioRunResult['runId'] below.
    if (!startedRunId) throw new Error("scenario_started never fired");
    const byRunId = svc.getScenarioRunResult(id, startedRunId);
    expect(byRunId).not.toBeNull();
    expect(byRunId!.runId).toBe(startedRunId);
    // Omitting runId resolves the same (latest) result.
    expect(svc.getScenarioRunResult(id)!.runId).toBe(startedRunId);
    // A runId that doesn't belong to this scenario resolves to null, not a
    // stale/foreign result.
    expect(svc.getScenarioRunResult(id, "not-a-real-run-id")).toBeNull();
  });
});
