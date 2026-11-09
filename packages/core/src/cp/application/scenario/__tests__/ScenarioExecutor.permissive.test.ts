import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNode,
} from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/**
 * The executor's tolerant contract: graph shapes it runs today without
 * failing the run. A validator (`validateScenarioGraph`) reports them, and
 * no validator may turn them into a hard failure. Listed under "Tolerant
 * contract" in docs/concepts/scenario-format.md; change both together.
 */

type Wiring = Array<[string, string] | [string, string, string]>;

function graph(nodes: ScenarioNode[], wiring: Wiring): ScenarioDefinition {
  return {
    ...linearScenario("permissive", []),
    nodes,
    edges: wiring.map(([source, target, sourceHandle], index) => ({
      id: `e${index}`,
      source,
      target,
      ...(sourceHandle === undefined ? {} : { sourceHandle }),
    })),
  };
}

const start = (id = "start") =>
  node(id, ScenarioNodeType.START, { label: "Start" });
const end = (id = "end") => node(id, ScenarioNodeType.END, { label: "End" });
/** A step that finishes at once and needs no callback. */
const step = (id: string, label = id) =>
  node(id, ScenarioNodeType.SET_STATE, { label, key: "k", value: 1 });

interface Run {
  executed: string[];
  logs: string[];
  warnings: string[];
  errors: Error[];
}

/** Run to completion, or stop once `maxNodes` nodes executed (loops). */
async function run(
  scenario: ScenarioDefinition,
  {
    maxNodes = 50,
    draw = 0.5,
    resumeFrom,
  }: { maxNodes?: number; draw?: number; resumeFrom?: string } = {},
): Promise<Run> {
  const result: Run = { executed: [], logs: [], warnings: [], errors: [] };
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    result.warnings.push(args.map(String).join(" "));
  });
  const callbacks: ScenarioExecutorCallbacks = {
    log: (message) => result.logs.push(message),
    onError: (error) => result.errors.push(error),
    onNodeExecute: (nodeId) => {
      result.executed.push(nodeId);
      if (result.executed.length >= maxNodes) executor.stop();
    },
  };
  const executor = new ScenarioExecutor(scenario, callbacks, undefined, {
    rng: { next: () => draw } as never,
  });
  await executor.start(
    resumeFrom === undefined ? undefined : { resumeFromNodeId: resumeFrom },
  );
  return result;
}

const completed = (r: Run) =>
  r.errors.length === 0 &&
  r.logs.some((l) => l.endsWith("Scenario execution completed"));

describe("ScenarioExecutor tolerant contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns on an unknown node type and goes on along its first edge", async () => {
    const r = await run(
      graph(
        [
          start(),
          node("odd", "notAType" as ScenarioNodeType, { label: "odd" }),
          step("a"),
          step("b"),
          end(),
        ],
        [
          ["start", "odd"],
          ["odd", "a"],
          ["odd", "b"],
          ["a", "end"],
        ],
      ),
    );
    expect(r.warnings).toContain("Unknown node type: notAType");
    expect(r.executed).toEqual(["start", "odd", "a", "end"]);
    expect(completed(r)).toBe(true);
  });

  it("skips an edge to a missing node, and ends the branch when all are", async () => {
    const skipped = await run(
      graph(
        [start(), step("a"), step("b")],
        [
          ["start", "a"],
          ["a", "gone"],
          ["a", "b"],
        ],
      ),
    );
    expect(skipped.executed).toEqual(["start", "a", "b"]);
    expect(completed(skipped)).toBe(true);

    const allGone = await run(
      graph(
        [start(), step("a")],
        [
          ["start", "a"],
          ["a", "gone"],
          ["start", "also-gone"],
        ],
      ),
    );
    expect(allGone.executed).toEqual(["start", "a"]);
    expect(allGone.warnings).toEqual([
      "[ScenarioExecutor] All outgoing edges from node a point to non-existent nodes. Branch will end here.",
    ]);
    expect(completed(allGone)).toBe(true);
  });

  it("never follows an edge out of END", async () => {
    const r = await run(
      graph(
        [start(), step("a"), end(), step("after")],
        [
          ["start", "a"],
          ["a", "end"],
          ["end", "after"],
        ],
      ),
    );
    expect(r.executed).toEqual(["start", "a", "end"]);
    expect(completed(r)).toBe(true);
  });

  it("runs START again as a step when an edge leads back into it", async () => {
    // A loop back to a single-branch START.
    const loop = await run(
      graph(
        [start(), step("a")],
        [
          ["start", "a"],
          ["a", "start"],
        ],
      ),
      { maxNodes: 5 },
    );
    expect(loop.executed).toEqual(["start", "a", "start", "a", "start"]);
    expect(loop.errors).toEqual([]);

    // Re-entered, a fanning START goes on along its first edge only.
    const fan = await run(
      graph(
        [start(), step("a"), end()],
        [
          ["start", "a"],
          ["start", "end"],
          ["a", "start"],
        ],
      ),
      { maxNodes: 8 },
    );
    // start, then its two branches a and end, then a → start → a → … only.
    expect(fan.executed[0]).toBe("start");
    expect([...fan.executed.slice(1, 3)].sort()).toEqual(["a", "end"]);
    expect(fan.executed.slice(3)).toEqual([
      "start",
      "a",
      "start",
      "a",
      "start",
    ]);
    expect(fan.errors).toEqual([]);
  });

  it("ignores a second START", async () => {
    const r = await run(
      graph(
        [start("s1"), step("a"), start("s2"), step("b")],
        [
          ["s1", "a"],
          ["s2", "b"],
        ],
      ),
    );
    expect(r.executed).toEqual(["s1", "a"]);
    expect(completed(r)).toBe(true);
  });

  it("treats nodes labelled Start and End as START and END", async () => {
    const r = await run(
      graph(
        [step("before"), step("s", "Start"), step("e", "End"), step("after")],
        [
          ["before", "s"],
          ["s", "e"],
          ["e", "after"],
        ],
      ),
    );
    // The first node labelled Start is where the run starts; a node labelled
    // End ends the branch.
    expect(r.executed).toEqual(["s", "e"]);
    expect(completed(r)).toBe(true);
  });

  it("ends the branch with a log when a switch picks a handle without an edge", async () => {
    const r = await run(
      graph(
        [
          start(),
          node("sw", ScenarioNodeType.SWITCH, {
            label: "sw",
            value: 5,
            cases: [0],
          }),
          step("zero"),
        ],
        [
          ["start", "sw"],
          ["sw", "zero", "case-0"],
        ],
      ),
    );
    expect(r.executed).toEqual(["start", "sw"]);
    expect(r.logs).toContain(
      '[permissive] "sw" chose "default", which has no edge; the branch ends',
    );
    expect(completed(r)).toBe(true);
  });

  it("ends the branch with a log when a choice picks a handle without an edge", async () => {
    const r = await run(
      graph(
        [
          start(),
          node("ch", ScenarioNodeType.CHOICE, {
            label: "ch",
            options: [{}, {}],
          }),
          step("first"),
        ],
        [
          ["start", "ch"],
          ["ch", "first", "option-0"],
        ],
      ),
      { draw: 0.9 },
    );
    expect(r.executed).toEqual(["start", "ch"]);
    expect(r.logs).toContain(
      '[permissive] "ch" chose "option-1", which has no edge; the branch ends',
    );
    expect(completed(r)).toBe(true);
  });

  it("never follows a switch / choice edge whose handle the node does not pick", async () => {
    // executeSwitch always sets a handle (case-N or default), so an edge
    // without one, or with a case the switch does not have, never runs.
    const r = await run(
      graph(
        [
          start(),
          node("sw", ScenarioNodeType.SWITCH, {
            label: "sw",
            value: 0,
            cases: [0],
          }),
          step("bare"),
          step("beyond"),
          step("zero"),
        ],
        [
          ["start", "sw"],
          ["sw", "bare"],
          ["sw", "beyond", "case-1"],
          ["sw", "zero", "case-0"],
        ],
      ),
    );
    expect(r.executed).toEqual(["start", "sw", "zero"]);
    expect(completed(r)).toBe(true);
  });

  it("resuming from an ordinary node runs all its outgoing edges in parallel", async () => {
    // executeFlow treats the resume point as the origin: every edge to an
    // existing node becomes a branch, not only the first one.
    const r = await run(
      graph(
        [start(), step("a"), step("b"), step("c")],
        [
          ["start", "a"],
          ["a", "b"],
          ["a", "c"],
        ],
      ),
      { resumeFrom: "a" },
    );
    expect([...r.executed].sort()).toEqual(["b", "c"]);
    expect(completed(r)).toBe(true);
  });

  it("resuming from a switch / choice runs the node again", async () => {
    // The picked handle is not persisted: the node decides again, then goes
    // on along that one edge.
    const r = await run(
      graph(
        [
          start(),
          node("sw", ScenarioNodeType.SWITCH, {
            label: "sw",
            value: 0,
            cases: [0],
          }),
          step("zero"),
          step("other"),
        ],
        [
          ["start", "sw"],
          ["sw", "zero", "case-0"],
          ["sw", "other", "default"],
        ],
      ),
      { resumeFrom: "sw" },
    );
    expect(r.executed).toEqual(["sw", "zero"]);
    expect(r.logs).toContain("Switch on 0 → case-0");
    expect(completed(r)).toBe(true);
  });

  it("never mutates the definition's node and edge arrays (the program cache relies on it)", async () => {
    // ScenarioExecutor.program() caches the lowered graph by the identity of
    // `nodes` / `edges`; an in-place change would go unseen. Frozen here, so
    // a write by the executor throws and fails the run.
    const def = graph(
      [
        start(),
        node("sw", ScenarioNodeType.SWITCH, {
          label: "sw",
          value: 0,
          cases: [0],
        }),
        step("a"),
        end(),
      ],
      [
        ["start", "sw"],
        ["sw", "a", "case-0"],
        ["a", "end"],
      ],
    );
    Object.freeze(def.nodes);
    Object.freeze(def.edges);
    def.nodes.forEach((n) => Object.freeze(n));
    def.edges.forEach((e) => Object.freeze(e));
    const r = await run(def);
    expect(r.executed).toEqual(["start", "sw", "a", "end"]);
    expect(completed(r)).toBe(true);
  });

  it("fails the run only when there is nowhere to start", async () => {
    const r = await run(graph([step("a")], []));
    expect(r.executed).toEqual([]);
    expect(r.errors.map((e) => e.message)).toEqual([
      "No start node found in scenario",
    ]);
  });
});
