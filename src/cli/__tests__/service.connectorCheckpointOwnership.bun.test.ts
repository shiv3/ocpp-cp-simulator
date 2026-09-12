import { describe, it, expect } from "bun:test";

import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * A connector's checkpoint belongs to the run that wrote it (#314).
 *
 * `runScenario` clears the connector's scenario position on the way in, on the
 * reasoning that "a run that is not resuming starts at the beginning, so
 * whatever was there belongs to a run that is over". That reasoning holds for a
 * *replacement* and fails for a *neighbour*: a connector can carry two runs at
 * once. The shipped default scenario (`essential-cp-behavior`) is instantiated
 * on every connector by `cp.create`, auto-starts on connect, and then parks on
 * `remoteStartTrigger` until a CSMS acts — so the resting state of a default
 * charge point is one run already in flight, and every operator `run_scenario`
 * arrives alongside it. The clear threw that run's checkpoint away, and with
 * `--state-db` the row it wrote through survived the restart that read it.
 *
 * The same ownership question the cleanup path asks on the way out is now asked
 * on the way in. What it cannot fix is bounded and structural: the position map
 * holds ONE entry per connector and `connector_runtime` ONE row, so once the
 * incoming run completes its first node it owns the slot and the neighbour's
 * checkpoint is gone. Representing both would mean a per-run checkpoint, which
 * is a schema change — deliberately not made here.
 */
function linear(id: string, park: boolean): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    nodes: [
      {
        id: `${id}-start`,
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: `${id}-a`,
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 1 },
        data: { label: "A", value: 11, sendMessage: false },
      },
      ...(park
        ? [
            {
              id: `${id}-park`,
              type: ScenarioNodeType.DELAY,
              position: { x: 0, y: 2 },
              data: { label: "park", delaySeconds: 60 },
            },
          ]
        : []),
      {
        id: `${id}-end`,
        type: ScenarioNodeType.END,
        position: { x: 0, y: 3 },
        data: { label: "E" },
      },
    ],
    edges: park
      ? [
          { id: `${id}-e1`, source: `${id}-start`, target: `${id}-a` },
          { id: `${id}-e2`, source: `${id}-a`, target: `${id}-park` },
          { id: `${id}-e3`, source: `${id}-park`, target: `${id}-end` },
        ]
      : [
          { id: `${id}-e1`, source: `${id}-start`, target: `${id}-a` },
          { id: `${id}-e2`, source: `${id}-a`, target: `${id}-end` },
        ],
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
  } as ScenarioDefinition;
}

/** The persisted row — the artifact that outlives a restart. */
interface PersistedPosition {
  scenarioKey?: string;
  lastCompletedNodeId?: string | null;
  executedNodes?: readonly string[];
}

interface Harness {
  readonly svc: CLIChargePointService;
  readonly db: ReturnType<typeof BunSqliteDatabase.open>;
  readonly position: () => PersistedPosition | null;
}

function newHarness(db = BunSqliteDatabase.open(":memory:")): Harness {
  const svc = new CLIChargePointService(
    {
      cpId: "cp-checkpoint",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    db,
  );
  const repo = (
    svc as unknown as {
      _runtimeRepo: {
        load: (
          cpId: string,
          connectorId: number,
        ) => { scenarioPosition?: unknown } | null;
      };
    }
  )._runtimeRepo;
  return {
    svc,
    db,
    position: () =>
      (repo.load("cp-checkpoint", 1)?.scenarioPosition as
        PersistedPosition | undefined) ?? null,
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

describe("a connector's checkpoint survives a neighbouring run starting (#314)", () => {
  it("leaves a still-running scenario's position alone", async () => {
    const { svc, position } = newHarness();
    try {
      const first = svc.loadScenario(1, linear("first", true), {
        autoStart: false,
      });
      svc.runScenario(1, first);
      // `first` has completed a node and parked on a 60s delay, so it is still
      // running when the second starts — the shipped default's shape.
      await settle();
      expect(position()).toEqual({
        scenarioKey: "first",
        lastCompletedNodeId: "first-a",
        executedNodes: ["first-start", "first-a"],
      });

      const second = svc.loadScenario(1, linear("second", true), {
        autoStart: false,
      });
      svc.runScenario(1, second);

      // The discriminating assertion: the persisted row still describes the run
      // that is still running. Unguarded, `runScenario`'s acquisition clear
      // deleted this and wrote the deletion through, so a restart in the window
      // before `second` completed its first node found nothing to resume and
      // `first` replayed from its START node.
      expect(position()).toEqual({
        scenarioKey: "first",
        lastCompletedNodeId: "first-a",
        executedNodes: ["first-start", "first-a"],
      });
    } finally {
      svc.cleanup(true);
    }
  });

  it("still clears a position left by a run that is over", async () => {
    // The case the acquisition clear exists for, and the one the guard must not
    // regress: `stopScenario` drops the executor synchronously and leaves its
    // `finally` queued, so at the moment the next run starts the old position
    // is present and its owner is NOT running. That position must go — left
    // behind, a restart before the new run's first node resumed the *new* graph
    // from the *old* graph's node ids.
    const { svc, position } = newHarness();
    try {
      const first = svc.loadScenario(1, linear("first", true), {
        autoStart: false,
      });
      svc.runScenario(1, first);
      await settle();
      expect(position()?.scenarioKey).toBe("first");

      svc.stopScenario(1, first);
      const second = svc.loadScenario(1, linear("second", true), {
        autoStart: false,
      });
      // Synchronously, inside the window where `first`'s cleanup is still a
      // queued microtask — assert before awaiting anything, or the queued
      // cleanup clears the position and the assertion stops discriminating.
      svc.runScenario(1, second);
      expect(position()).toBeNull();
    } finally {
      svc.cleanup(true);
    }
  });

  it("does not mix a neighbour's node ids into this run's trail", async () => {
    // The defect the preserve introduced. `node.complete` accumulated onto
    // whatever the connector's slot held, so the incoming run appended its own
    // node ids to the preserved neighbour's and stamped the result with its own
    // `scenarioKey`. The row that survives a restart then names one graph and
    // lists another's nodes, the structural resume check rejects it for the
    // foreign ids, and the run replays from its start node — every
    // side-effecting node it had already executed fires a second time. A
    // corrupted checkpoint is worse than the cleared one it replaced.
    const first = newHarness();
    try {
      const a = first.svc.loadScenario(1, linear("first", true), {
        autoStart: false,
      });
      first.svc.runScenario(1, a);
      await settle();
      expect(first.position()?.scenarioKey).toBe("first");

      const b = first.svc.loadScenario(1, linear("second", true), {
        autoStart: false,
      });
      first.svc.runScenario(1, b);
      await settle();

      // The row is purely the writer's: same key, and no node from the graph
      // that is still parked beside it.
      expect(first.position()).toEqual({
        scenarioKey: "second",
        lastCompletedNodeId: "second-a",
        executedNodes: ["second-start", "second-a"],
      });
    } finally {
      first.svc.cleanup(false);
    }

    // The assertion that matters is what the next boot does with that row, not
    // what the row looks like: a restart must resume the second scenario past
    // the node it had finished, not replay it. Mixed, `executedNodes` carried
    // `first-*` ids that resolve in no node of this graph, the structural check
    // failed, and `second-a` ran again.
    const second = newHarness(first.db);
    try {
      const b = second.svc.loadScenario(1, linear("second", true), {
        autoStart: false,
      });
      second.svc.restoreConnectorRuntimeFromDatabase();
      const executed: string[] = [];
      second.svc.onEvent((ev) => {
        if (
          ev.event === "scenario_node_execute" &&
          typeof ev.data.nodeId === "string"
        ) {
          executed.push(ev.data.nodeId);
        }
      });
      second.svc.runScenario(1, b);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(executed).toContain("second-park");
      expect(executed).not.toContain("second-a");
    } finally {
      second.svc.cleanup(true);
    }
  });
});
