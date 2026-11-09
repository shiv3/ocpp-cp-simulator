import { describe, expect, it, vi, afterEach } from "vitest";
import { VirtualClock } from "../../../shared/clock";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNode,
} from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/**
 * Loop edges (schema 1.10): `kind: "loop"` with `loop: { times, forSeconds,
 * until }`. Rounds are counted by watching which nodes execute; time comes from
 * a VirtualClock that only the delay nodes move.
 */

afterEach(() => vi.restoreAllMocks());

type Extra = Record<string, unknown>;
const edge = (
  id: string,
  source: string,
  target: string,
  extra: Extra = {},
) => ({
  id,
  source,
  target,
  ...extra,
});
const loop = (
  id: string,
  source: string,
  target: string,
  bounds: unknown,
  extra: Extra = {},
) => edge(id, source, target, { kind: "loop", loop: bounds, ...extra });

const start = () => node("start", ScenarioNodeType.START, { label: "Start" });
const end = () => node("end", ScenarioNodeType.END, { label: "End" });
const step = (id: string, key = id, value: unknown = true): ScenarioNode =>
  node(id, ScenarioNodeType.SET_STATE, { label: id, key, value });
const delay = (id: string, seconds: number): ScenarioNode =>
  node(id, ScenarioNodeType.DELAY, { label: id, delaySeconds: seconds });

function graph(
  nodes: ScenarioNode[],
  edges: Array<ReturnType<typeof edge>>,
): ScenarioDefinition {
  return { ...linearScenario("loops", []), nodes, edges };
}

interface Run {
  executed: string[];
  logs: string[];
  errors: Error[];
  clock: VirtualClock;
}

async function run(
  scenario: ScenarioDefinition,
  {
    maxNodes = 60,
    resumeFrom,
    onReadStation,
  }: {
    maxNodes?: number;
    resumeFrom?: string;
    onReadStation?: ScenarioExecutorCallbacks["onReadStation"];
  } = {},
): Promise<Run> {
  const clock = new VirtualClock();
  const result: Run = { executed: [], logs: [], errors: [], clock };
  const callbacks: ScenarioExecutorCallbacks = {
    log: (message) => result.logs.push(message),
    onError: (error) => result.errors.push(error),
    onNodeExecute: (nodeId) => {
      result.executed.push(nodeId);
      if (result.executed.length >= maxNodes) executor.stop();
    },
    // A delay is the only thing that moves the station clock.
    onDelay: (seconds) => clock.advanceBy(seconds * 1000),
    ...(onReadStation ? { onReadStation } : {}),
  };
  const executor = new ScenarioExecutor(scenario, callbacks, undefined, {
    clock,
  });
  await executor.start(
    resumeFrom === undefined ? undefined : { resumeFromNodeId: resumeFrom },
  );
  return result;
}

const count = (r: Run, id: string) => r.executed.filter((n) => n === id).length;
const completed = (r: Run) =>
  r.errors.length === 0 &&
  r.logs.some((l) => l.endsWith("Scenario execution completed"));

/** start → body → end, with `bound` as a loop edge body → body. */
const selfLoop = (bound: unknown, body: ScenarioNode = step("body")) =>
  graph(
    [start(), body, end()],
    [
      edge("e1", "start", body.id),
      edge("e2", body.id, "end"),
      loop("loop", body.id, body.id, bound),
    ],
  );

describe("times", () => {
  it.each([1, 2, 5])("runs the source exactly %i round(s)", async (times) => {
    const r = await run(selfLoop({ times }));
    expect(count(r, "body")).toBe(times);
    expect(r.executed.at(-1)).toBe("end");
    expect(completed(r)).toBe(true);
    expect(r.logs.some((l) => l.includes(`exits (times ${times})`))).toBe(true);
  });

  it("times 0 behaves like 1 (the check runs after the first round)", async () => {
    const r = await run(selfLoop({ times: 0 }));
    expect(count(r, "body")).toBe(1);
    expect(completed(r)).toBe(true);
  });

  it("a header other than the source: the whole body repeats", async () => {
    const r = await run(
      graph(
        [start(), step("h"), step("b"), step("s"), end()],
        [
          edge("e1", "start", "h"),
          edge("e2", "h", "b"),
          edge("e3", "b", "s"),
          edge("e4", "s", "end"),
          loop("l", "s", "h", { times: 3 }),
        ],
      ),
    );
    expect(r.executed.filter((n) => n !== "start")).toEqual([
      ...["h", "b", "s", "h", "b", "s", "h", "b", "s"],
      "end",
    ]);
  });
});

describe("forSeconds (station clock)", () => {
  it("exits at the first check at or after the deadline; a round that crosses it completes", async () => {
    // 10 s rounds, 25 s: checks at 10, 20, 30 → exits after the third round.
    const r = await run(selfLoop({ forSeconds: 25 }, delay("body", 10)));
    expect(count(r, "body")).toBe(3);
    expect(completed(r)).toBe(true);
    expect(r.logs.some((l) => l.includes("exits (forSeconds 25)"))).toBe(true);
  });

  it("a deadline hit exactly counts (>=)", async () => {
    const r = await run(selfLoop({ forSeconds: 20 }, delay("body", 10)));
    expect(count(r, "body")).toBe(2);
  });

  it("forSeconds 0 exits at the first check", async () => {
    const r = await run(selfLoop({ forSeconds: 0 }, delay("body", 10)));
    expect(count(r, "body")).toBe(1);
  });
});

describe("until (switch case semantics)", () => {
  it("a constant case", async () => {
    const r = await run(
      selfLoop(
        {
          until: { value: { $from: "state.x" }, cases: ["done"] },
        },
        step("body", "x", "done"),
      ),
    );
    expect(count(r, "body")).toBe(1);
    expect(completed(r)).toBe(true);
    expect(r.logs.some((l) => l.includes("exits (until case 0)"))).toBe(true);
  });

  it("a constant that never matches loops until another bound", async () => {
    const r = await run(
      selfLoop(
        {
          times: 4,
          until: { value: { $from: "state.x" }, cases: ["never"] },
        },
        step("body", "x", "other"),
      ),
    );
    expect(count(r, "body")).toBe(4);
  });

  it("a $match case on a station value that changes each round", async () => {
    let soc = 0;
    const r = await run(
      selfLoop({
        until: {
          value: { $from: "connector.power.soc" },
          cases: [{ $match: { gte: 80 } }],
        },
      }),
      {
        onReadStation: (root) =>
          root === "connector" ? { power: { soc: (soc += 30) } } : undefined,
      },
    );
    // 30, 60, 90: exits at the third check.
    expect(count(r, "body")).toBe(3);
    expect(completed(r)).toBe(true);
  });

  it("a missing value is picked up by an exists:false case", async () => {
    const r = await run(
      selfLoop({
        until: {
          value: { $from: "state.nothing" },
          cases: [{ $match: { exists: false } }],
        },
      }),
    );
    expect(count(r, "body")).toBe(1);
    expect(completed(r)).toBe(true);
  });

  it("a missing value without such a case fails the run, as a switch does", async () => {
    const r = await run(
      selfLoop({
        until: { value: { $from: "state.nothing" }, cases: ["a"] },
      }),
    );
    expect(completed(r)).toBe(false);
    expect(r.errors[0]!.message).toContain("state.nothing");
    // The same failure a switch gives.
    const sw = await run(
      graph(
        [
          start(),
          node("sw", ScenarioNodeType.SWITCH, {
            label: "sw",
            value: { $from: "state.nothing" },
            cases: ["a"],
          }),
        ],
        [edge("e1", "start", "sw")],
      ),
    );
    const tail = (m: string) => m.slice(m.indexOf("state.nothing"));
    expect(tail(r.errors[0]!.message)).toBe(tail(sw.errors[0]!.message));
  });

  it("a $from inside a case is refused like a switch's", async () => {
    const r = await run(
      selfLoop(
        {
          until: {
            value: { $from: "state.x" },
            cases: [{ $from: "state.y" }],
          },
        },
        step("body", "x", 1),
      ),
    );
    expect(r.errors[0]!.message).toContain("cases are JSON constants");
  });
});

describe("several bounds and no bound", () => {
  it("the first satisfied bound exits", async () => {
    const r = await run(
      selfLoop(
        {
          times: 10,
          forSeconds: 25,
          until: { value: { $from: "charger.id" }, cases: ["never"] },
        },
        delay("body", 10),
      ),
      { onReadStation: () => ({ id: "CP1" }) },
    );
    expect(count(r, "body")).toBe(3);
    expect(r.logs.some((l) => l.includes("exits (forSeconds 25)"))).toBe(true);
  });

  it("no bound loops forever (stopped after N nodes)", async () => {
    const r = await run(selfLoop({}), { maxNodes: 20 });
    expect(count(r, "body")).toBeGreaterThanOrEqual(15);
    expect(r.executed).not.toContain("end");
  });

  it("a loop edge without a loop object loops forever too", async () => {
    const r = await run(
      graph(
        [start(), step("body"), end()],
        [
          edge("e1", "start", "body"),
          edge("e2", "body", "end"),
          edge("l", "body", "body", { kind: "loop" }),
        ],
      ),
      { maxNodes: 20 },
    );
    expect(r.executed).not.toContain("end");
  });
});

describe("exit", () => {
  it("with no ordinary edge the branch ends", async () => {
    const r = await run(
      graph(
        [start(), step("body")],
        [edge("e1", "start", "body"), loop("l", "body", "body", { times: 2 })],
      ),
    );
    expect(r.executed).toEqual(["start", "body", "body"]);
    expect(completed(r)).toBe(true);
  });

  it("the ordinary edge is the first non-loop edge, whatever the file order", async () => {
    const r = await run(
      graph(
        [start(), step("body"), step("a"), step("b")],
        [
          edge("e1", "start", "body"),
          loop("l", "body", "body", { times: 2 }),
          edge("ea", "body", "a"),
          edge("eb", "body", "b"),
        ],
      ),
    );
    expect(r.executed).toEqual(["start", "body", "body", "a"]);
  });
});

describe("edges that are ignored", () => {
  it("a loop edge out of a switch is never followed", async () => {
    const r = await run(
      graph(
        [
          start(),
          node("sw", ScenarioNodeType.SWITCH, {
            label: "sw",
            value: 1,
            cases: [2],
          }),
          step("m"),
        ],
        [
          edge("e1", "start", "sw"),
          edge("d", "sw", "m", { sourceHandle: "default" }),
          loop("l", "sw", "sw", { times: 5 }),
        ],
      ),
    );
    expect(r.executed).toEqual(["start", "sw", "m"]);
  });

  it("a loop edge out of the origin START is never followed", async () => {
    const r = await run(
      graph(
        [start(), step("a")],
        [edge("e1", "start", "a"), loop("l", "start", "start", { times: 3 })],
      ),
    );
    expect(r.executed).toEqual(["start", "a"]);
  });

  it("of several loop edges out of a node only the first counts", async () => {
    const r = await run(
      graph(
        [start(), step("body"), step("x"), end()],
        [
          edge("e1", "start", "body"),
          edge("e2", "body", "end"),
          loop("l1", "body", "body", { times: 2 }),
          loop("l2", "body", "x", { times: 1 }),
        ],
      ),
    );
    expect(count(r, "body")).toBe(2);
    expect(r.executed).not.toContain("x");
  });

  it("a loop edge to a missing node is skipped; the next one counts", async () => {
    const r = await run(
      graph(
        [start(), step("body"), end()],
        [
          edge("e1", "start", "body"),
          edge("e2", "body", "end"),
          loop("l1", "body", "ghost", { times: 9 }),
          loop("l2", "body", "body", { times: 2 }),
        ],
      ),
    );
    expect(count(r, "body")).toBe(2);
  });

  it("a plain back edge (no kind) still loops forever", async () => {
    const r = await run(
      graph(
        [start(), step("a"), step("b")],
        [
          edge("e1", "start", "a"),
          edge("e2", "a", "b"),
          edge("e3", "b", "a", { loop: { times: 1 } }),
        ],
      ),
      { maxNodes: 30 },
    );
    expect(count(r, "a")).toBeGreaterThan(5);
  });
});

describe("counters", () => {
  it("nested loops: the inner counter restarts each outer round", async () => {
    // O → I (I loops 2 rounds) → X → back to O (3 outer rounds).
    const r = await run(
      graph(
        [start(), step("o"), step("i"), step("x"), end()],
        [
          edge("e1", "start", "o"),
          edge("e2", "o", "i"),
          edge("e3", "i", "x"),
          edge("e4", "x", "end"),
          loop("inner", "i", "i", { times: 2 }),
          loop("outer", "x", "o", { times: 3 }),
        ],
      ),
    );
    expect(count(r, "o")).toBe(3);
    expect(count(r, "i")).toBe(6);
    expect(count(r, "x")).toBe(3);
    expect(completed(r)).toBe(true);
  });

  it("parallel branches keep separate counters", async () => {
    const r = await run(
      graph(
        [start(), step("h")],
        [
          edge("e1", "start", "h"),
          edge("e2", "start", "h"),
          loop("l", "h", "h", { times: 3 }),
        ],
      ),
    );
    expect(count(r, "h")).toBe(6);
    expect(completed(r)).toBe(true);
  });

  it("a second run of the same loop starts fresh when entered again by an ordinary edge", async () => {
    // An outer loop (2 rounds) re-enters the inner one (2 rounds) through the
    // ordinary edge g → body, so the inner counter starts over: 4 body rounds.
    const r = await run(
      graph(
        [start(), step("g"), step("body"), step("hop"), end()],
        [
          edge("e1", "start", "g"),
          edge("e2", "g", "body"),
          edge("e3", "body", "hop"),
          edge("e4", "hop", "end"),
          loop("inner", "body", "body", { times: 2 }),
          loop("outer", "hop", "g", { times: 2 }),
        ],
      ),
    );
    expect(count(r, "g")).toBe(2);
    expect(count(r, "body")).toBe(4);
  });

  it("resuming inside the loop body restarts the counters", async () => {
    // Fresh run: s runs 3 rounds. Resumed at b (as after a restart in round 2
    // of 3): the walk begins after b, the loop has no state yet, so it counts
    // three rounds again from there.
    const scenario = graph(
      [start(), step("h"), step("b"), step("s"), end()],
      [
        edge("e1", "start", "h"),
        edge("e2", "h", "b"),
        edge("e3", "b", "s"),
        edge("e4", "s", "end"),
        loop("l", "s", "h", { times: 3 }),
      ],
    );
    const fresh = await run(scenario);
    expect(count(fresh, "s")).toBe(3);
    const resumed = await run(scenario, { resumeFrom: "b" });
    expect(count(resumed, "s")).toBe(3);
    expect(count(resumed, "h")).toBe(2);
    expect(resumed.executed.at(-1)).toBe("end");
    // Resumed at the loop's source itself: that node counts as done, so the
    // branch goes on along its ordinary edge and the loop edge is not followed.
    const atSource = await run(scenario, { resumeFrom: "s" });
    expect(atSource.executed.filter((n) => n !== "start")).toEqual(["end"]);
  });
});

describe("tolerant contract: malformed loops fail the run only when reached", () => {
  it.each([
    ["times is a string", { times: "3" }, "loop.times"],
    ["times is negative", { times: -1 }, "loop.times"],
    ["forSeconds is not finite", { forSeconds: null }, "loop.forSeconds"],
    ["until has no cases", { until: { value: 1 } }, "cases must be an array"],
    ["until is not an object", { until: 5 }, "loop.until"],
    ["loop is not an object", 7, "loop must be an object"],
  ])("%s", async (_name, bounds, message) => {
    const r = await run(selfLoop(bounds));
    expect(completed(r)).toBe(false);
    expect(r.errors[0]!.message).toContain('loop edge "loop"');
    expect(r.errors[0]!.message).toContain(message);
  });

  it("a malformed loop that is never reached does not fail the run", async () => {
    const r = await run(
      graph(
        [start(), step("a"), step("dead"), end()],
        [
          edge("e1", "start", "a"),
          edge("e2", "a", "end"),
          loop("bad", "dead", "dead", { times: "x" }),
        ],
      ),
    );
    expect(completed(r)).toBe(true);
  });

  it("unknown keys in loop are ignored", async () => {
    const r = await run(selfLoop({ times: 2, speed: "fast" }));
    expect(count(r, "body")).toBe(2);
  });
});
