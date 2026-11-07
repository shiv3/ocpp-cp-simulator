// Runs a scenario definition with a real ScenarioExecutor against the station
// of a BehaviorRun (see runBehavior.ts), on the same virtual clock.
import type { Edge } from "@xyflow/react";
import { ScenarioExecutor } from "../../cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../../cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioEvents,
  ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
import { EventEmitter } from "../../cp/shared/EventEmitter";
import type { BehaviorRun } from "./runBehavior";

export interface Step {
  readonly id: string;
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

const node = (step: Step): ScenarioNode =>
  ({
    id: step.id,
    type: step.type,
    position: { x: 0, y: 0 },
    data: { label: step.id, ...(step.data ?? {}) },
  }) as unknown as ScenarioNode;

const edge = (source: string, target: string): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
});

/** `start → steps… → end` on one branch, or several branches from `start`. */
export function definition(
  branches: readonly (readonly Step[])[] | readonly Step[],
  id = "s-test",
): ScenarioDefinition {
  const lists: readonly (readonly Step[])[] = Array.isArray(branches[0])
    ? (branches as readonly (readonly Step[])[])
    : [branches as readonly Step[]];
  const nodes: ScenarioNode[] = [node({ id: "start", type: "start" })];
  const edges: Edge[] = [];
  lists.forEach((steps, b) => {
    let previous = "start";
    for (const step of steps) {
      nodes.push(node(step));
      edges.push(edge(previous, step.id));
      previous = step.id;
    }
    const end = `end-${b}`;
    nodes.push(node({ id: end, type: "end" }));
    edges.push(edge(previous, end));
  });
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

export interface ScenarioRun {
  readonly executor: ScenarioExecutor;
  /** "running" until the run ends, then how it ended. */
  state(): "running" | "completed" | "error";
  error(): string | undefined;
  /** Resolves when the run ended (completed, failed or stopped). */
  finished: Promise<void>;
  stop(): Promise<void>;
}

export function startScenario(
  run: BehaviorRun,
  def: ScenarioDefinition,
): ScenarioRun {
  const connector = run.cp.getConnector(def.targetId ?? 1);
  if (!connector) throw new Error("no such connector");
  const callbacks = createScenarioExecutorCallbacks({
    chargePoint: run.cp,
    connector,
  });
  const events = new EventEmitter<ScenarioEvents>();
  let state: "running" | "completed" | "error" = "running";
  let error: string | undefined;
  events.on("execution.completed", () => {
    state = "completed";
  });
  events.on("execution.error", (info) => {
    state = "error";
    error = (info as { error: string }).error;
  });
  const executor = new ScenarioExecutor(def, callbacks, events, {
    clock: run.clock,
  });
  const finished = executor.start().then(
    () => undefined,
    () => undefined,
  );
  return {
    executor,
    state: () => state,
    error: () => error,
    finished,
    stop: async () => {
      executor.stop();
      await finished;
    },
  };
}

/** The station's answer to the CSMS CALL with this id, if it has sent one. */
export function answerTo(
  run: BehaviorRun,
  id: string,
): { kind: "result" | "error"; payload: unknown } | undefined {
  const frame = run
    .frames()
    .find((f) => f.dir === "CP>" && f.id === id && f.kind !== "call");
  return frame
    ? { kind: frame.kind as "result" | "error", payload: frame.payload }
    : undefined;
}
