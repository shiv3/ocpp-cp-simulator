import { afterEach, describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { MAX_RUNS_PER_CP } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRepository";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ChargePointEvent } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { memoryDatabase } from "@ocpp-cp-simulator/core/test/sqlJsMemoryDatabase";
import { LocalChargePointService } from "./LocalChargePointService";

/**
 * #394: a scenario run in the browser leaves the same report as on the
 * daemon, in the `scenario_runs` table of the browser database.
 */

const CP_ID = "CP-RUNS";

const node = (
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
) =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  }) as ScenarioNode;

function scenario(
  id: string,
  extra: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START),
      node("set", ScenarioNodeType.STATUS_CHANGE, {
        status: OCPPStatus.Preparing,
      }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e1", source: "start", target: "set" },
      { id: "e2", source: "set", target: "end" },
    ],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
    ...extra,
  };
}

/** Parks on a status the test never reaches. */
const parking = (id: string): ScenarioDefinition =>
  scenario(id, {
    nodes: [
      node("start", ScenarioNodeType.START),
      node("wait", ScenarioNodeType.STATUS_TRIGGER, {
        targetStatus: OCPPStatus.Faulted,
        timeout: 60,
      }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e1", source: "start", target: "wait" },
      { id: "e2", source: "wait", target: "end" },
    ],
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const definitionOf = (id: string) => ({
  id,
  connectorNumber: 1,
  bootNotification: DefaultBootNotification,
  wsUrl: "ws://127.0.0.1:1/ocpp/",
  basicAuth: null,
  autoMeterValueSetting: null,
  ocppVersion: "OCPP-1.6J",
});

let service: LocalChargePointService | null = null;
afterEach(async () => {
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
});

async function setup(database: Database | null) {
  service = new LocalChargePointService(database);
  await service.syncLocalChargePoints([definitionOf(CP_ID)]);
  const chargePoint = service.getLocalChargePoint(CP_ID) as ChargePoint;
  const events: ChargePointEvent[] = [];
  service.subscribe(CP_ID, (event) => events.push(event));
  return { service, chargePoint, events };
}

describe("Local scenario run history (#394)", () => {
  it("records a finished run with the daemon's report shape", async () => {
    const { service, events } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, scenario("s-ok"));
    await service.runScenario(CP_ID, 1, "s-ok");
    await settle();

    const report = await service.getScenarioReport(CP_ID, 1, "s-ok");
    expect(report).toMatchObject({
      schemaVersion: 1,
      scenarioId: "s-ok",
      scenarioName: "Scenario s-ok",
      cpId: CP_ID,
      connectorId: 1,
      ocppVersion: "OCPP-1.6J",
      executionState: "completed",
      stopped: false,
      verdict: "SKIPPED",
      errors: [],
      timeout: null,
      interventions: [],
    });
    expect(report?.initialState.connectorStatus).not.toBe("Preparing");
    expect(report?.finalState.connectorStatus).toBe("Preparing");

    // The run id is on the lifecycle events and on scenario-run-recorded.
    const runId = report!.runId;
    const withRunId = events.filter(
      (e) => (e as { runId?: string }).runId === runId,
    );
    expect(withRunId.map((e) => e.type)).toContain("scenario-started");
    expect(withRunId.map((e) => e.type)).toContain("scenario-run-recorded");
    expect(await service.getScenarioReport(CP_ID, 1, "s-ok", runId)).toEqual(
      report,
    );
    expect(
      await service.getScenarioReport(CP_ID, 1, "other", runId),
    ).toBeNull();

    const page = await service.listScenarioRuns({ cpId: CP_ID });
    expect(page.total).toBe(1);
    expect(page.runs[0]).toMatchObject({ runId, scenarioId: "s-ok" });
  });

  it("records a run stopped mid-wait as stopped, with its timeout", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, parking("s-park"));
    void service.runScenario(CP_ID, 1, "s-park");
    await settle();
    await service.stopScenario(CP_ID, 1, "s-park");
    await settle();

    const report = await service.getScenarioReport(CP_ID, 1, "s-park");
    expect(report).toMatchObject({
      stopped: true,
      executionState: "completed",
      timeout: { nodeId: "wait" },
    });
    expect((await service.listScenarioRuns({ cpId: CP_ID })).total).toBe(1);
  });

  it("records a failing run as an error", async () => {
    const { service } = await setup(await memoryDatabase());
    // No Start node: the executor throws "No start node found".
    const broken = scenario("s-bad", {
      nodes: [node("end", ScenarioNodeType.END)],
      edges: [],
    });
    await service.loadScenario(CP_ID, 1, broken);
    await service.runScenario(CP_ID, 1, "s-bad");
    await settle();

    const report = await service.getScenarioReport(CP_ID, 1, "s-bad");
    expect(report?.executionState).toBe("error");
    expect(report?.errors.length).toBeGreaterThan(0);
  });

  it("deleting a scenario mid-run discards the run without a report", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, parking("s-del"));
    void service.runScenario(CP_ID, 1, "s-del");
    await settle();
    await service.removeScenario(CP_ID, 1, "s-del");
    await settle();
    expect((await service.listScenarioRuns({})).total).toBe(0);
  });

  it("keeps the latest 100 runs per charge point", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, scenario("s-many"));
    for (let i = 0; i < MAX_RUNS_PER_CP + 3; i += 1) {
      await service.runScenario(CP_ID, 1, "s-many");
    }
    await settle();
    const page = await service.listScenarioRuns({ cpId: CP_ID, limit: 500 });
    expect(page.total).toBe(MAX_RUNS_PER_CP);
  });

  it("filters and pages like the daemon", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, scenario("s-a"));
    await service.loadScenario(CP_ID, 1, scenario("s-b"));
    await service.runScenario(CP_ID, 1, "s-a");
    await service.runScenario(CP_ID, 1, "s-b");
    await service.runScenario(CP_ID, 1, "s-a");
    await settle();

    expect((await service.listScenarioRuns({ scenarioId: "s-a" })).total).toBe(
      2,
    );
    const first = await service.listScenarioRuns({ limit: 1 });
    expect(first.runs).toHaveLength(1);
    expect(first.total).toBe(3);
    const second = await service.listScenarioRuns({ limit: 1, offset: 1 });
    expect(second.runs[0].runId).not.toBe(first.runs[0].runId);
  });

  it("survives a page reload: a new service on the same database lists the run", async () => {
    const database = await memoryDatabase();
    const first = await setup(database);
    await first.service.loadScenario(CP_ID, 1, scenario("s-persist"));
    await first.service.runScenario(CP_ID, 1, "s-persist");
    await settle();
    const runId = (await first.service.listScenarioRuns({})).runs[0].runId;
    await first.service.syncLocalChargePoints([definitionOf(CP_ID)]);

    const reloaded = new LocalChargePointService(database);
    expect((await reloaded.listScenarioRuns({})).runs[0].runId).toBe(runId);
    expect(
      (await reloaded.getScenarioReport(CP_ID, 1, "s-persist", runId))?.runId,
    ).toBe(runId);
  });

  it("drops a removed charge point's runs, and all of them on reset", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.syncLocalChargePoints([
      definitionOf(CP_ID),
      definitionOf("CP-OTHER"),
    ]);
    await service.loadScenario(CP_ID, 1, scenario("s-x"));
    await service.loadScenario("CP-OTHER", 1, scenario("s-y"));
    await service.runScenario(CP_ID, 1, "s-x");
    await service.runScenario("CP-OTHER", 1, "s-y");
    await settle();
    expect((await service.listScenarioRuns({})).total).toBe(2);

    await service.syncLocalChargePoints([definitionOf("CP-OTHER")], {
      forget: true,
    });
    const remaining = await service.listScenarioRuns({});
    expect(remaining.runs.map((r) => r.cpId)).toEqual(["CP-OTHER"]);

    await service.resetAllState();
    expect((await service.listScenarioRuns({})).total).toBe(0);
  });

  it("keeps run history when charge points are only released and come back (mode round trip)", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, scenario("s-trip"));
    await service.runScenario(CP_ID, 1, "s-trip");
    await settle();
    expect((await service.listScenarioRuns({})).total).toBe(1);

    // Entering Remote mode / an unloaded config releases without forgetting.
    await service.syncLocalChargePoints([]);
    await service.syncLocalChargePoints([definitionOf(CP_ID)]);
    expect((await service.listScenarioRuns({ cpId: CP_ID })).total).toBe(1);
  });

  it("records one report per connector when the same scenario id runs on two connectors", async () => {
    service = new LocalChargePointService(await memoryDatabase());
    await service.syncLocalChargePoints([
      { ...definitionOf(CP_ID), connectorNumber: 2 },
    ]);
    await service.loadScenario(CP_ID, 1, parking("s-same"));
    await service.loadScenario(CP_ID, 2, {
      ...parking("s-same"),
      targetId: 2,
    });
    void service.runScenario(CP_ID, 1, "s-same");
    void service.runScenario(CP_ID, 2, "s-same");
    await settle();
    await service.stopScenario(CP_ID, 1, "s-same");
    await service.stopScenario(CP_ID, 2, "s-same");
    await settle();

    const page = await service.listScenarioRuns({ cpId: CP_ID });
    expect(page.total).toBe(2);
    expect(page.runs.map((r) => r.connectorId).sort()).toEqual([1, 2]);
    expect(new Set(page.runs.map((r) => r.runId)).size).toBe(2);
  });

  it("evaluates declared assertions into the verdict, passing and failing", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(
      CP_ID,
      1,
      scenario("s-pass", {
        assertions: [{ id: "a1", type: "ocpp_absent", action: "Authorize" }],
      }),
    );
    await service.loadScenario(
      CP_ID,
      1,
      scenario("s-fail", {
        assertions: [{ id: "a1", type: "ocpp_sent", action: "Authorize" }],
      }),
    );
    await service.runScenario(CP_ID, 1, "s-pass");
    await service.runScenario(CP_ID, 1, "s-fail");
    await settle();

    const pass = await service.getScenarioReport(CP_ID, 1, "s-pass");
    const fail = await service.getScenarioReport(CP_ID, 1, "s-fail");
    expect(pass?.assertions.map((a) => a.status)).toEqual(["passed"]);
    expect(pass?.verdict).toBe("PASS");
    expect(fail?.assertions.map((a) => a.status)).toEqual(["failed"]);
    expect(fail?.verdict).toBe("FAIL");
  });

  it("records an extendWait intervention in the report", async () => {
    const { service } = await setup(await memoryDatabase());
    await service.loadScenario(CP_ID, 1, parking("s-int"));
    void service.runScenario(CP_ID, 1, "s-int");
    await settle();
    await service.extendScenarioWait(CP_ID, 1, "s-int", 30);
    await service.stopScenario(CP_ID, 1, "s-int");
    await settle();

    const report = await service.getScenarioReport(CP_ID, 1, "s-int");
    expect(report?.interventions).toHaveLength(1);
    expect(report?.interventions[0]).toMatchObject({ kind: "extend" });
  });

  it("works without a database (in memory)", async () => {
    const { service } = await setup(null);
    await service.loadScenario(CP_ID, 1, scenario("s-mem"));
    await service.runScenario(CP_ID, 1, "s-mem");
    await settle();
    expect((await service.listScenarioRuns({})).total).toBe(1);
  });
});
