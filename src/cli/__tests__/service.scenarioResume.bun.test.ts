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

    const executedNodes: string[] = [];
    svc.onEvent((ev) => {
      if (
        ev.event === "scenario_node_execute" &&
        typeof ev.data.nodeId === "string"
      ) {
        executedNodes.push(ev.data.nodeId);
      }
    });

    svc.runScenario(1, boot2Id);
    await new Promise((r) => setTimeout(r, 600));

    // node-a MUST be skipped on resume; only node-b runs. Pre-fix the
    // resume opts were dropped and both fired (false negative for the
    // bug we're guarding against).
    expect(executedNodes).toContain("node-b");
    expect(executedNodes).not.toContain("node-a");
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

    const executedNodes: string[] = [];
    svc.onEvent((ev) => {
      if (
        ev.event === "scenario_node_execute" &&
        typeof ev.data.nodeId === "string"
      ) {
        executedNodes.push(ev.data.nodeId);
      }
    });

    svc.runScenario(1, id);
    await new Promise((r) => setTimeout(r, 600));

    // Structural match fails → full replay: both A and B run.
    expect(executedNodes).toContain("node-a");
    expect(executedNodes).toContain("node-b");
  });
});

/**
 * The stop paths' half of the same story (#314).
 *
 * `stopScenario` / `stopAllScenarios` drop the executor synchronously, so the
 * queued `finally` in `runScenario` finds a different (absent) executor under
 * the id and takes the supersede branch. That branch exists for a run that was
 * *replaced* — it must not delete the replacement's bookkeeping — but a stopped
 * run has no replacement, and skipping the cleanup left its last node in
 * `connector_runtime`. With `--state-db` the next boot then resumed the very
 * scenario the operator had stopped.
 */
function buildParkedInstance(connectorId: number): ScenarioDefinition {
  return {
    id: `parked-c${connectorId}`,
    name: "Parked",
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
        id: "hold",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 2 },
        data: { label: "Hold", delaySeconds: 30 },
      },
      {
        id: "node-b",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 3 },
        data: { label: "B", value: 22, sendMessage: false },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 4 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "node-a" },
      { id: "e2", source: "node-a", target: "hold" },
      { id: "e3", source: "hold", target: "node-b" },
      { id: "e4", source: "node-b", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

describe("a manually stopped run leaves nothing to resume from (#314)", () => {
  function storedPosition(db: BunDb): string | null {
    const rows = db.all<{ scenario_position_json: string | null }>(
      "SELECT scenario_position_json FROM connector_runtime " +
        "WHERE cp_id = ? AND connector_id = ?",
      ["stop-cp", 1],
    );
    return rows[0]?.scenario_position_json ?? null;
  }

  async function waitFor(
    predicate: () => boolean,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it("clears and persists the position when stop_scenario ends the run", async () => {
    // `BunDb.open` rather than the raw handle the tests above use: it runs the
    // migrations itself, and its typed constructor keeps this file's error
    // count where it was.
    const db = BunDb.open(":memory:");
    const svc = new CLIChargePointService(
      {
        cpId: "stop-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );

    const id = svc.loadScenario(1, buildParkedInstance(1));
    svc.runScenario(1, id);
    // Parked in the 30s delay with node-a behind it, so there is a real
    // position on disk to lose.
    await waitFor(
      () => storedPosition(db) !== null,
      "the run to record a position",
    );
    expect(storedPosition(db)).toContain("node-a");

    svc.stopScenario(1, id);
    // The stop is synchronous; the run's own `finally` is a queued microtask.
    await waitFor(
      () => storedPosition(db) === null,
      "the stopped run to clear its persisted position",
    );

    // And the restart it protects: a fresh service over the same database has
    // nothing to resume from, so the scenario replays from the start rather
    // than picking up where the operator stopped it.
    const restarted = new CLIChargePointService(
      {
        cpId: "stop-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );
    restarted.restoreConnectorRuntimeFromDatabase();
    const executed: string[] = [];
    restarted.onEvent((ev) => {
      if (
        ev.event === "scenario_node_execute" &&
        typeof ev.data.nodeId === "string"
      ) {
        executed.push(ev.data.nodeId);
      }
    });
    const restartedId = restarted.loadScenario(1, buildParkedInstance(1));
    restarted.runScenario(1, restartedId);
    await waitFor(
      () => executed.includes("node-a"),
      "the restarted run to replay from the start",
    );
    restarted.stopScenario(1, restartedId);
    svc.cleanup(true);
    restarted.cleanup(true);
  });
});

describe("a replacement run does not inherit the old graph's remains (#314)", () => {
  function storedPosition(db: BunDb, cpId: string): string | null {
    const rows = db.all<{ scenario_position_json: string | null }>(
      "SELECT scenario_position_json FROM connector_runtime " +
        "WHERE cp_id = ? AND connector_id = ?",
      [cpId, 1],
    );
    return rows[0]?.scenario_position_json ?? null;
  }

  async function waitFor(
    predicate: () => boolean,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it("clears the connector position when a run starts without resuming", async () => {
    // The ownership-versus-replacement split. When a scenario is replaced under
    // the same id the new run takes the slot, but the *stale value* on the
    // connector is not replaced until the new run completes its first node —
    // and it is persisted, so a restart inside that window resumed the new
    // graph from the old graph's node ids. Acquisition clears it instead, so
    // the replacement starts from a clean slate.
    const db = BunDb.open(":memory:");
    const svc = new CLIChargePointService(
      {
        cpId: "replace-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );

    try {
      const first = svc.loadScenario(1, buildParkedInstance(1));
      svc.runScenario(1, first);
      await waitFor(
        () => storedPosition(db, "replace-cp") !== null,
        "the first run to record a position",
      );
      expect(storedPosition(db, "replace-cp")).toContain("node-a");

      // The replacement, under the same id, exactly as
      // `scenario.definitions.replace` installs it — and started before the
      // outgoing run's `finally` has run.
      const replacement = {
        ...buildParkedInstance(1),
        id: first,
        nodes: buildParkedInstance(1).nodes.map((n) =>
          n.id === "node-a" ? { ...n, id: "different-node" } : n,
        ),
        edges: buildParkedInstance(1).edges.map((e) => ({
          ...e,
          source: e.source === "node-a" ? "different-node" : e.source,
          target: e.target === "node-a" ? "different-node" : e.target,
        })),
      } as ScenarioDefinition;
      // The production sequence for `scenario.definitions.replace`: the runtime
      // map is reconciled — which discards the in-flight run and swaps the
      // definition — and the replacement starts in the same tick, before the
      // outgoing run's queued `finally` gets to run.
      svc.syncConnectorRuntimeScenarios(1, [replacement]);
      svc.runScenario(1, replacement.id);

      // The old graph's node ids are gone from the connector immediately —
      // before the replacement has completed anything of its own.
      const after = storedPosition(db, "replace-cp");
      expect(after === null || !after.includes("node-a")).toBe(true);

      svc.stopScenario(1, replacement.id);
      svc.cleanup(true);
    } finally {
      db.close();
    }
  });

  it("releases an EV settings override the replacement does not claim", async () => {
    // The other connector-scoped artifact, and the half acquisition cannot
    // cover: the override is one boolean on the connector with no per-run
    // owner, so a replacement that declares no `evSettings` of its own never
    // touches it. The outgoing run owes it — whether or not it kept the slot —
    // and skipping that on the replaced path left default-EV-settings
    // propagation blocked for the life of the connector.
    const db = BunDb.open(":memory:");
    const svc = new CLIChargePointService(
      {
        cpId: "evs-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );
    try {
      const withEv = {
        ...buildParkedInstance(1),
        evSettings: { maxChargingPowerKw: 7 },
      } as ScenarioDefinition;
      const id = svc.loadScenario(1, withEv);
      svc.runScenario(1, id);
      await new Promise((r) => setTimeout(r, 50));

      // Replaced under the same id by a definition with no EV settings, and
      // started before the outgoing run unwinds.
      const plain = { ...buildParkedInstance(1), id } as ScenarioDefinition;
      svc.syncConnectorRuntimeScenarios(1, [plain]);
      svc.runScenario(1, id);
      await new Promise((r) => setTimeout(r, 50));

      const connector = (
        svc as unknown as {
          _chargePoint: {
            getConnector(id: number):
              | {
                  applyDefaultEvSettings(s: unknown): void;
                  evSettings: { maxChargingPowerKw?: number };
                }
              | undefined;
          };
        }
      )._chargePoint.getConnector(1);
      // The override is unmarked, so default propagation takes effect again.
      connector?.applyDefaultEvSettings({ maxChargingPowerKw: 22 });
      expect(connector?.evSettings.maxChargingPowerKw).toBe(22);

      svc.stopScenario(1, id);
      svc.cleanup(true);
    } finally {
      db.close();
    }
  });

  it("leaves an override the replacement claimed for itself", async () => {
    // The other half of "unless the new occupant has claimed it". When the
    // replacement declares its own `evSettings` it has already set the
    // override, and the outgoing run clearing it would unmark a live one —
    // letting default propagation overwrite the settings the running scenario
    // asked for. Ownership transferring is not permission to clean up.
    const db = BunDb.open(":memory:");
    const svc = new CLIChargePointService(
      {
        cpId: "evs-keep-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
        basicAuth: null,
      },
      db,
    );
    try {
      const first = {
        ...buildParkedInstance(1),
        evSettings: { maxChargingPowerKw: 7 },
      } as ScenarioDefinition;
      const id = svc.loadScenario(1, first);
      svc.runScenario(1, id);
      await new Promise((r) => setTimeout(r, 50));

      // Replaced by a definition that declares EV settings of its own.
      const claiming = {
        ...buildParkedInstance(1),
        id,
        evSettings: { maxChargingPowerKw: 11 },
      } as ScenarioDefinition;
      svc.syncConnectorRuntimeScenarios(1, [claiming]);
      svc.runScenario(1, id);
      await new Promise((r) => setTimeout(r, 50));

      const connector = (
        svc as unknown as {
          _chargePoint: {
            getConnector(id: number):
              | {
                  applyDefaultEvSettings(s: unknown): void;
                  evSettings: { maxChargingPowerKw?: number };
                }
              | undefined;
          };
        }
      )._chargePoint.getConnector(1);
      const before = connector?.evSettings.maxChargingPowerKw;
      // Still overridden, so the default cannot take it over.
      connector?.applyDefaultEvSettings({ maxChargingPowerKw: 22 });
      expect(connector?.evSettings.maxChargingPowerKw).toBe(before);
      expect(connector?.evSettings.maxChargingPowerKw).not.toBe(22);

      svc.stopScenario(1, id);
      svc.cleanup(true);
    } finally {
      db.close();
    }
  });
});
