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
 * Reproduces the daemon-restart resume failure mode the E2E run exposed:
 *
 *   - On boot 1 the scenario template is instantiated with a runtime id
 *     containing `Date.now()` + a random suffix (see scenarioTemplates.ts).
 *     The persisted ScenarioPositionSnapshot stamps that id as
 *     `scenarioKey`.
 *   - On boot 2 the same template is instantiated again — but it gets a
 *     fresh timestamp + suffix, so the new instance id !== the saved key.
 *
 * The original `pending.scenarioKey === scenarioId` check therefore
 * always failed across restarts, and the executor replayed from the
 * START node (re-firing Plug In / Start Transaction etc.). The fix
 * matches by node-id structure instead: if the saved
 * lastCompletedNodeId + executedNodes still resolve in the new
 * scenario's node graph, resume is honored.
 */
function buildScenarioInstance(
  templateId: string,
  cpId: string,
  connectorId: number,
  instanceSuffix: string,
): ScenarioDefinition {
  return {
    id: `${templateId}-${cpId}-c${connectorId}-${Date.now()}-${instanceSuffix}`,
    name: "Linear",
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
        id: "node-a",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 1 },
        data: { label: "A", value: 11, sendMessage: false },
      },
      {
        id: "node-b",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 2 },
        data: { label: "B", value: 22, sendMessage: false },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 3 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "node-a" },
      { id: "e2", source: "node-a", target: "node-b" },
      { id: "e3", source: "node-b", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("runScenario resume across daemon restart", () => {
  it("honors a persisted position even when the new scenario instance id differs from the saved key", async () => {
    const raw = new BunSqliteDatabase(":memory:");
    const db = new BunDb(raw);
    runMigrations(db);

    const svc = new CLIChargePointService(
      {
        cpId: "test-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
      },
      db,
    );

    const boot1Def = buildScenarioInstance("t", "test-cp", 1, "boot1");
    const boot1Id = svc.loadScenario(1, boot1Def);

    // Pretend boot 1 ran through node-a and then the daemon was killed:
    // write the connector_runtime row directly to set up the resume state.
    const repo = (
      svc as unknown as {
        _runtimeRepo: {
          save: (cpId: string, connectorId: number, snap: unknown) => void;
        };
      }
    )._runtimeRepo;
    repo.save("test-cp", 1, {
      status: "Charging",
      availability: "Operative",
      meterValueWh: 100,
      scenarioPosition: {
        // The bug: this id encodes Date.now(), so on the next boot the
        // freshly-instantiated scenario gets a different one.
        scenarioKey: boot1Id,
        lastCompletedNodeId: "node-a",
        executedNodes: ["start-1", "node-a"],
      },
    });

    svc.restoreConnectorRuntimeFromDatabase();

    // Boot 2 ⇒ same template, different runtime id.
    const boot2Def = buildScenarioInstance("t", "test-cp", 1, "boot2");
    const boot2Id = svc.loadScenario(1, boot2Def);
    expect(boot2Id).not.toBe(boot1Id);

    const meterVals: number[] = [];
    const cp = (
      svc as unknown as { _chargePoint: { connectors: Map<number, unknown> } }
    )._chargePoint;
    const connector = cp.connectors.get(1) as {
      events: {
        on: (e: string, cb: (data: { meterValue: number }) => void) => void;
      };
    };
    connector.events.on("meterValueChange", ({ meterValue }) => {
      meterVals.push(meterValue);
    });

    svc.runScenario(1, boot2Id);
    await new Promise((r) => setTimeout(r, 600));

    // node-a's set (value=11) MUST be skipped; only node-b's (value=22)
    // fires. Pre-fix: both fire because the resume opts were dropped.
    expect(meterVals).toContain(22);
    expect(meterVals).not.toContain(11);
  });

  it("falls back to a fresh run when the persisted node ids don't exist in the new scenario", async () => {
    const raw = new BunSqliteDatabase(":memory:");
    const db = new BunDb(raw);
    runMigrations(db);

    const svc = new CLIChargePointService(
      {
        cpId: "test-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
      },
      db,
    );
    const def = buildScenarioInstance("t", "test-cp", 1, "current");
    const id = svc.loadScenario(1, def);

    const repo = (
      svc as unknown as {
        _runtimeRepo: {
          save: (cpId: string, connectorId: number, snap: unknown) => void;
        };
      }
    )._runtimeRepo;
    repo.save("test-cp", 1, {
      status: "Charging",
      availability: "Operative",
      meterValueWh: 0,
      scenarioPosition: {
        scenarioKey: "any",
        // ← node id that was removed from the scenario graph between
        // persistence and the next boot.
        lastCompletedNodeId: "node-removed",
        executedNodes: ["start-1", "node-removed"],
      },
    });
    svc.restoreConnectorRuntimeFromDatabase();

    const meterVals: number[] = [];
    const cp = (
      svc as unknown as { _chargePoint: { connectors: Map<number, unknown> } }
    )._chargePoint;
    const connector = cp.connectors.get(1) as {
      events: {
        on: (e: string, cb: (data: { meterValue: number }) => void) => void;
      };
    };
    connector.events.on("meterValueChange", ({ meterValue }) => {
      meterVals.push(meterValue);
    });

    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 600));

    // Structural match fails → full replay: both A and B run.
    expect(meterVals).toContain(11);
    expect(meterVals).toContain(22);
  });
});
