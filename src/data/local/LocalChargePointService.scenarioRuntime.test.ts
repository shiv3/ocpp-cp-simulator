import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { Database, SqlParam } from "../../cp/domain/persistence/Database";
import { runMigrations } from "../../cp/domain/persistence/schema";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";
import type { ChargePointEvent } from "../interfaces/ChargePointService";
import { LocalChargePointService } from "./LocalChargePointService";

/**
 * The browser (Local mode) scenario runtime lives in the data layer: a
 * charge point registered with LocalChargePointService can load, run and
 * auto-start scenarios — and reports their progress as service events —
 * without any React component mounted. The console relies on this; it never
 * built a ScenarioManager itself.
 */

const CP_ID = "CP-RT";

/** In-memory sql.js database behind the domain `Database` port, so the
 *  service, its ChargePoints and the scenario repository share real SQL. */
async function memoryDatabase(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const coerce = (params: SqlParam[]) =>
    params.map((p) => (typeof p === "boolean" ? Number(p) : p));
  const adapter: Database = {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.run(sql, coerce(params));
    },
    all: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      const rows: T[] = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
      } finally {
        stmt.free();
      }
      return rows;
    },
    get: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      try {
        return stmt.step() ? (stmt.getAsObject() as T) : null;
      } finally {
        stmt.free();
      }
    },
    close: () => db.close(),
  };
  runMigrations(adapter);
  return adapter;
}

function node(
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as ScenarioNode;
}

function chain(...ids: string[]): ScenarioDefinition["edges"] {
  return ids.slice(1).map((target, i) => ({
    id: `e-${ids[i]}-${target}`,
    source: ids[i],
    target,
  }));
}

/** Start → StatusChange(status) → End on connector 1. */
function statusScenario(
  id: string,
  status: OCPPStatus,
  extra: Partial<ScenarioDefinition> = {},
  startData: Record<string, unknown> = {},
): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START, startData),
      node("set", ScenarioNodeType.STATUS_CHANGE, { status }),
      node("end", ScenarioNodeType.END),
    ],
    edges: chain("start", "set", "end"),
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
    ...extra,
  };
}

/** Start → wait for a status this test never reaches → End. */
function parkingScenario(id: string): ScenarioDefinition {
  return {
    ...statusScenario(id, OCPPStatus.Preparing),
    nodes: [
      node("start", ScenarioNodeType.START),
      node("wait", ScenarioNodeType.STATUS_TRIGGER, {
        targetStatus: OCPPStatus.Faulted,
        timeout: 60,
      }),
      node("end", ScenarioNodeType.END),
    ],
    edges: chain("start", "wait", "end"),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let service: LocalChargePointService | null = null;

afterEach(async () => {
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
});

async function setup(database: Database | null = null): Promise<{
  service: LocalChargePointService;
  chargePoint: ChargePoint;
  events: ChargePointEvent[];
}> {
  service = new LocalChargePointService(database);
  await service.syncLocalChargePoints([
    {
      id: CP_ID,
      connectorNumber: 1,
      bootNotification: DefaultBootNotification,
      wsUrl: "ws://127.0.0.1:1/ocpp/",
      basicAuth: null,
      autoMeterValueSetting: null,
      ocppVersion: "OCPP-1.6J",
    },
  ]);
  const chargePoint = service.getLocalChargePoint(CP_ID) as ChargePoint;
  const events: ChargePointEvent[] = [];
  service.subscribe(CP_ID, (event) => events.push(event));
  return { service, chargePoint, events };
}

function scenarioEvents(events: ChargePointEvent[]) {
  return events
    .filter((e) => e.type.startsWith("scenario-"))
    .map((e) => {
      const { type, scenarioId } = e as { type: string; scenarioId: string };
      const nodeId = (e as { nodeId?: string }).nodeId;
      return nodeId
        ? `${type}:${scenarioId}:${nodeId}`
        : `${type}:${scenarioId}`;
    });
}

describe("LocalChargePointService scenario runtime (no UI mounted)", () => {
  it("loads and runs a scenario, reporting its progress as service events", async () => {
    const { service, chargePoint, events } = await setup();
    // ScenarioManager.executeScenario silently skips a run while the CP is
    // not Available, so set it explicitly (normally BootNotification does).
    chargePoint.status = OCPPStatus.Available;
    const definition = statusScenario("s-run", OCPPStatus.Preparing);

    const { scenarioId } = await service.loadScenario(CP_ID, 1, definition);
    await service.runScenario(CP_ID, 1, scenarioId);
    await settle();

    expect(chargePoint.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    expect(scenarioEvents(events)).toEqual([
      "scenario-started:s-run",
      "scenario-node-execute:s-run:start",
      "scenario-node-execute:s-run:set",
      "scenario-node-execute:s-run:end",
      "scenario-completed:s-run",
    ]);
  });

  it("loading a scenario keeps the other scenarios loaded on the connector", async () => {
    const { service, chargePoint } = await setup();
    await service.loadScenario(
      CP_ID,
      1,
      statusScenario("s-a", OCPPStatus.Preparing),
    );
    await service.loadScenario(
      CP_ID,
      1,
      statusScenario("s-b", OCPPStatus.Charging),
    );

    const ids = (await service.listScenarios(CP_ID, 1)).map(
      (s) => s.scenarioId,
    );
    expect(ids.sort()).toEqual(["s-a", "s-b"]);
    expect(chargePoint.getConnector(1)?.scenarioManager).toBeDefined();
  });

  it("reports operator wait controls as scenario-wait-changed events", async () => {
    const { service, chargePoint, events } = await setup();
    chargePoint.status = OCPPStatus.Available;
    await service.loadScenario(CP_ID, 1, parkingScenario("s-wait"));
    const run = service.runScenario(CP_ID, 1, "s-wait");
    await settle();

    await service.continueScenarioWait(CP_ID, 1, "s-wait");
    await run;

    expect(events).toContainEqual({
      type: "scenario-wait-changed",
      connectorId: 1,
      scenarioId: "s-wait",
      nodeId: "wait",
      kind: "continue",
    });
  });

  it("reports a stopped run as completed, like the daemon", async () => {
    const { service, chargePoint, events } = await setup();
    chargePoint.status = OCPPStatus.Available;
    await service.loadScenario(CP_ID, 1, parkingScenario("s-stop"));
    void service.runScenario(CP_ID, 1, "s-stop");
    await settle();

    await service.stopScenario(CP_ID, 1, "s-stop");
    await settle();

    expect(
      scenarioEvents(events).filter((e) => e === "scenario-completed:s-stop"),
    ).toHaveLength(1);
  });

  it("auto-starts a saved connect-triggered scenario when the CP becomes Available", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario("s-connect", OCPPStatus.Preparing),
    );
    await settle();

    chargePoint.status = OCPPStatus.Available;
    await settle();

    expect(chargePoint.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    expect(scenarioEvents(events)).toContain("scenario-completed:s-connect");
  });

  it("does not auto-start the same unchanged scenario twice", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario("s-once", OCPPStatus.Preparing),
    );
    chargePoint.status = OCPPStatus.Available;
    await settle();
    chargePoint.status = OCPPStatus.Available;
    await settle();

    expect(
      scenarioEvents(events).filter((e) => e === "scenario-started:s-once"),
    ).toHaveLength(1);
  });

  it("auto-starts a scenario saved while the CP is already Available", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    chargePoint.status = OCPPStatus.Available;
    await settle();

    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario("s-saved", OCPPStatus.Preparing),
    );
    await settle();

    expect(scenarioEvents(events)).toContain("scenario-completed:s-saved");
  });

  it("auto-starts a status-gated scenario when the connector reaches its target status", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    chargePoint.status = OCPPStatus.Available;
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario(
        "s-gated",
        OCPPStatus.Finishing,
        {},
        { triggerOn: "status", targetStatus: OCPPStatus.Charging },
      ),
    );
    await settle();
    expect(scenarioEvents(events)).toEqual([]);

    chargePoint.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle();

    expect(scenarioEvents(events)).toContain("scenario-completed:s-gated");
  });

  it("re-evaluates status-gated scenarios once the CP becomes Available", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario(
        "s-boot",
        OCPPStatus.Finishing,
        {},
        { triggerOn: "status", targetStatus: OCPPStatus.Charging },
      ),
    );
    // The connector reaches its target while the CP is still booting: the
    // gate is closed, so nothing may start yet.
    chargePoint.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle();
    expect(scenarioEvents(events)).toEqual([]);

    chargePoint.status = OCPPStatus.Available;
    await settle();

    expect(scenarioEvents(events)).toContain("scenario-completed:s-boot");
  });

  it("a disabled sibling does not re-arm an already-fired scenario", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    chargePoint.status = OCPPStatus.Available;
    // A one-off template instance loaded disabled (`once`), next to the
    // saved status-gated scenario.
    await service.loadScenario(CP_ID, 1, {
      ...statusScenario("s-once-instance", OCPPStatus.Preparing),
      enabled: false,
    });
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario(
        "s-gated-once",
        OCPPStatus.Charging,
        {},
        { triggerOn: "status", targetStatus: OCPPStatus.Charging },
      ),
    );
    chargePoint.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle();

    // Status oscillation: away from the target, then back to it.
    chargePoint.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
    await settle();
    chargePoint.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle();

    expect(
      scenarioEvents(events).filter(
        (e) => e === "scenario-started:s-gated-once",
      ),
    ).toHaveLength(1);
  });

  it("runs a saved statusChange-triggered scenario on a matching connector transition", async () => {
    const { service, chargePoint, events } = await setup(
      await memoryDatabase(),
    );
    chargePoint.status = OCPPStatus.Available;
    await service.saveScenarioDefinition(
      CP_ID,
      1,
      statusScenario("s-trigger", OCPPStatus.Finishing, {
        trigger: {
          type: "statusChange",
          conditions: { toStatus: OCPPStatus.Charging },
        },
      }),
    );
    await settle();
    expect(scenarioEvents(events)).toEqual([]);

    chargePoint.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle();

    expect(scenarioEvents(events)).toContain("scenario-completed:s-trigger");
    expect(chargePoint.getConnector(1)?.status).toBe(OCPPStatus.Finishing);
  });

  it("stops the runtime when the charge point is removed", async () => {
    const { service, chargePoint } = await setup();
    chargePoint.status = OCPPStatus.Available;
    const connector = chargePoint.getConnector(1)!;
    await service.loadScenario(CP_ID, 1, parkingScenario("s-removed"));
    void service.runScenario(CP_ID, 1, "s-removed");
    await settle();
    const manager = connector.scenarioManager!;
    expect(manager.getActiveScenarioIds()).toEqual(["s-removed"]);

    await service.syncLocalChargePoints([]);

    expect(manager.getActiveScenarioIds()).toEqual([]);
    expect(connector.scenarioManager).toBeUndefined();
  });
});
