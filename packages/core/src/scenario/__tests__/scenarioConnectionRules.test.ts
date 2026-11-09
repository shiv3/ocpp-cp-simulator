import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ScenarioNodeType } from "../../cp/application/scenario/ScenarioTypes";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import {
  CONNECTION_RULES,
  connectionRule,
  validateScenarioGraph,
  type ConnectionRule,
  type ConnectionRuleTable,
} from "../scenarioConnectionRules";

const node = (id: string, type = "delay", data?: Record<string, unknown>) => ({
  id,
  type,
  ...(data ? { data } : {}),
});
const edge = (source: string, target: string) => ({
  id: `${source}>${target}`,
  source,
  target,
});
const codes = (def: Parameters<typeof validateScenarioGraph>[0]) =>
  validateScenarioGraph(def).map((i) => i.code);

// Compile-time guard: the table must name every node type. If a new
// ScenarioNodeType is added without a rule, `tsc -b` fails on
// CONNECTION_RULES itself; this checks the table type keeps demanding it.
// @ts-expect-error a table that leaves node types out does not compile
const _partial: ConnectionRuleTable = {
  [ScenarioNodeType.START]: { out: "parallel", call: () => "none" },
};
type MissingRules = Exclude<ScenarioNodeType, keyof typeof CONNECTION_RULES>;
const _noneMissing: [MissingRules] extends [never] ? true : false = true;
// @ts-expect-error out is a closed set, not a number
const _badOut: ConnectionRule = { out: 1, call: () => "none" };

describe("connectionRule", () => {
  it("has a rule for every node type at run time too", () => {
    for (const type of Object.values(ScenarioNodeType)) {
      expect(CONNECTION_RULES[type], type).toBeDefined();
    }
    expect(_noneMissing).toBe(true);
  });

  it("START fans out, END ends the branch, the rest leave by their first edge", () => {
    expect(connectionRule("start").out).toBe("parallel");
    expect(connectionRule("end").out).toBe("none");
    expect(connectionRule("delay").out).toBe("next");
    expect(connectionRule("remoteStartTrigger").out).toBe("next");
    expect(connectionRule("not-a-type").out).toBe("next");
    expect(connectionRule("constructor").out).toBe("next");
    expect(connectionRule(undefined).out).toBe("next");
  });

  it("derives the CALL effect from the node data", () => {
    const trigger = connectionRule("csmsCallTrigger");
    expect(trigger.call({ behavior: "replace" })).toBe("takesOver");
    expect(trigger.call({ behavior: "observe" })).toBe("none");
    expect(trigger.call(undefined)).toBe("none");
    expect(connectionRule("callResponse").call(undefined)).toBe("answers");
    const call = connectionRule("ocppCall");
    expect(call.call({ payload: { id: { $from: "call.messageId" } } })).toBe(
      "reads",
    );
    expect(call.call({ payload: { id: { $from: "x", other: 1 } } })).toBe(
      "none",
    );
    expect(connectionRule("delay").call(undefined)).toBe("none");
  });
});

describe("validateScenarioGraph", () => {
  it("accepts a chain, a fan-out from START, a loop and a join", () => {
    const nodes = [node("s", "start"), node("a"), node("b"), node("e", "end")];
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "b"), edge("b", "e")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("s", "b"), edge("a", "e")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "b"), edge("b", "a")] }),
    ).toEqual([]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("s", "b"), edge("a", "b")] }),
    ).toEqual([]);
  });

  it("flags a fork anywhere but START: only the first edge runs", () => {
    const issues = validateScenarioGraph({
      nodes: [node("s", "start"), node("a"), node("b"), node("c")],
      edges: [edge("s", "a"), edge("a", "b"), edge("a", "c")],
    });
    expect(issues).toEqual([
      { code: "extraOutgoing", nodeId: "a", severity: "warning" },
    ]);
  });

  it("flags a missing START as an error, and extra STARTs", () => {
    expect(validateScenarioGraph({ nodes: [node("a")], edges: [] })).toEqual([
      { code: "missingStart", severity: "error" },
    ]);
    expect(
      codes({
        nodes: [node("s1", "start"), node("s2", "start")],
        edges: [],
      }),
    ).toEqual(["multipleStart"]);
  });

  it("flags edges into a fanning START, out of END and to missing nodes", () => {
    const nodes = [node("s", "start"), node("a"), node("e", "end")];
    // Re-entering a single-branch START is just a loop.
    expect(codes({ nodes, edges: [edge("s", "a"), edge("a", "s")] })).toEqual(
      [],
    );
    expect(
      codes({
        nodes,
        edges: [edge("s", "a"), edge("s", "e"), edge("a", "s")],
      }),
    ).toEqual(["edgeIntoStart"]);
    expect(codes({ nodes, edges: [edge("s", "a"), edge("e", "a")] })).toEqual([
      "edgeOutOfEnd",
    ]);
    expect(
      codes({ nodes, edges: [edge("s", "a"), edge("a", "gone")] }),
    ).toEqual(["danglingEdge"]);
  });

  it("flags a node no path from START reaches, but not a lone END", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("a"),
          node("orphan"),
          node("e", "end"),
        ],
        edges: [edge("s", "a")],
      }),
    ).toEqual(["unreachable"]);
  });

  it("treats a node labelled End as the end of its branch, like the executor", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("a", "statusChange", { label: "End" }),
          node("b"),
        ],
        edges: [edge("s", "a"), edge("a", "b")],
      }),
    ).toEqual(["edgeOutOfEnd", "unreachable"]);
  });

  it("starts from the first node labelled Start when there is no START", () => {
    expect(
      codes({
        nodes: [node("s", "delay", { label: "Start" }), node("a")],
        edges: [edge("s", "a"), edge("s", "a")],
      }),
    ).toEqual([]);
  });

  it("every shipped template is clean", () => {
    for (const template of scenarioTemplates) {
      const def = template.createScenario("cp", null);
      expect(validateScenarioGraph(def), template.id).toEqual([]);
    }
  });

  it("every docs example scenario is clean", () => {
    const dir = fileURLToPath(
      new URL("../../../../../docs/examples/scenarios", import.meta.url),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const def = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      expect(validateScenarioGraph(def), file).toEqual([]);
    }
  });
});

describe("validateScenarioGraph: the CALL a branch holds", () => {
  const replace = (id: string) =>
    node(id, "csmsCallTrigger", { action: "Reset", behavior: "replace" });
  const respond = (id: string) => node(id, "callResponse", { kind: "result" });
  const issuesOf = (
    nodes: ReturnType<typeof node>[],
    edges: ReturnType<typeof edge>[],
  ) => validateScenarioGraph({ nodes, edges });

  it("accepts a replace trigger answered later in its branch, also in a loop", () => {
    expect(
      issuesOf(
        [node("s", "start"), replace("t"), node("d"), respond("r")],
        [edge("s", "t"), edge("t", "d"), edge("d", "r")],
      ),
    ).toEqual([]);
    expect(
      issuesOf(
        [node("s", "start"), replace("t"), respond("r")],
        [edge("s", "t"), edge("t", "r"), edge("r", "t")],
      ),
    ).toEqual([]);
  });

  it("flags a callResponse no replace trigger precedes, e.g. right after START", () => {
    expect(
      issuesOf([node("s", "start"), respond("r")], [edge("s", "r")]),
    ).toEqual([{ code: "noCallHeld", nodeId: "r", severity: "error" }]);
    // An observe trigger hands the branch nothing.
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("t", "csmsCallTrigger", { action: "Reset" }),
          respond("r"),
        ],
        edges: [edge("s", "t"), edge("t", "r")],
      }),
    ).toEqual(["noCallHeld"]);
  });

  it("scopes the CALL to its branch from START", () => {
    expect(
      codes({
        nodes: [node("s", "start"), replace("t"), node("d"), respond("r")],
        edges: [
          edge("s", "t"),
          edge("s", "d"),
          edge("t", "r"),
          edge("d", "r"), // join: this path holds no CALL
        ],
      }),
    ).toEqual(["noCallHeld"]);
  });

  it("flags a second callResponse for one CALL", () => {
    expect(
      issuesOf(
        [node("s", "start"), replace("t"), respond("r1"), respond("r2")],
        [edge("s", "t"), edge("t", "r1"), edge("r1", "r2")],
      ),
    ).toEqual([
      { code: "callAlreadyAnswered", nodeId: "r2", severity: "error" },
    ]);
  });

  it("flags a $from in an ocppCall without a CALL, not one after an answer", () => {
    const call = node("c", "ocppCall", {
      action: "DataTransfer",
      payload: { messageId: { $from: "call.messageId" } },
    });
    expect(
      codes({ nodes: [node("s", "start"), call], edges: [edge("s", "c")] }),
    ).toEqual(["noCallHeld"]);
    expect(
      codes({
        nodes: [node("s", "start"), replace("t"), respond("r"), call],
        edges: [edge("s", "t"), edge("t", "r"), edge("r", "c")],
      }),
    ).toEqual([]);
  });

  it("warns on a replace trigger whose CALL its branch never answers", () => {
    expect(
      issuesOf(
        [node("s", "start"), replace("t"), node("e", "end")],
        [edge("s", "t"), edge("t", "e")],
      ),
    ).toEqual([{ code: "callLeftOpen", nodeId: "t", severity: "warning" }]);
    // Taking over a second CALL drops the first one.
    expect(
      codes({
        nodes: [node("s", "start"), replace("t1"), replace("t2"), respond("r")],
        edges: [edge("s", "t1"), edge("t1", "t2"), edge("t2", "r")],
      }),
    ).toEqual(["callLeftOpen"]);
  });

  it("follows only the edge the executor takes", () => {
    // `a` forks: only its first edge runs, so the answer on the second
    // edge does not count and the CALL stays open.
    expect(
      codes({
        nodes: [
          node("s", "start"),
          replace("t"),
          node("e", "end"),
          respond("r"),
        ],
        edges: [edge("s", "t"), edge("t", "e"), edge("t", "r")],
      }),
    ).toEqual(["extraOutgoing", "callLeftOpen"]);
  });
});

describe("validateScenarioGraph: decision nodes and the roots of $from (schema 1.6)", () => {
  it("lets a switch or choice leave by several edges: one per handle", () => {
    const nodes = [
      node("s", "start"),
      node("sw", "switch"),
      node("a"),
      node("b"),
      node("e", "end"),
    ];
    const edges = [
      edge("s", "sw"),
      edge("sw", "a"),
      edge("sw", "b"),
      edge("a", "e"),
      edge("b", "e"),
    ];
    expect(codes({ nodes, edges })).toEqual([]);
    expect(connectionRule("switch").out).toBe("select");
    expect(connectionRule("choice").out).toBe("select");
    // A plain step with the same shape still half runs.
    expect(
      codes({
        nodes: nodes.map((n) => (n.id === "sw" ? node("sw") : n)),
        edges,
      }),
    ).toEqual(["extraOutgoing"]);
  });

  it("follows every edge of a switch when it checks the CALL", () => {
    const nodes = [
      node("s", "start"),
      node("sw", "switch"),
      node("ok", "callResponse", { kind: "result" }),
      node("other"),
    ];
    // Both handles lead on without a CALL: the callResponse one cannot run.
    expect(
      codes({
        nodes,
        edges: [edge("s", "sw"), edge("sw", "ok"), edge("sw", "other")],
      }),
    ).toEqual(["noCallHeld"]);
  });

  it("notify and setState are plain steps", () => {
    expect(connectionRule("notify").out).toBe("next");
    expect(connectionRule("setState").out).toBe("next");
    expect(connectionRule("notify").call(undefined)).toBe("none");
  });

  it("only a $from on the call root needs the CALL", () => {
    const read = (path: string) =>
      node("c", "ocppCall", {
        action: "DataTransfer",
        payload: { x: { $from: path } },
      });
    const run = (path: string) =>
      codes({
        nodes: [node("s", "start"), read(path)],
        edges: [edge("s", "c")],
      });
    expect(run("call.payload.requestId")).toEqual(["noCallHeld"]);
    expect(run("state.attempts")).toEqual([]);
    expect(run("charger.status")).toEqual([]);
    expect(run("connector.transactionId")).toEqual([]);
  });
});
