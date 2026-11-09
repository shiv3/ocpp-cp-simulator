import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ScenarioNodeType } from "../../cp/application/scenario/ScenarioTypes";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import {
  CONNECTION_RULES,
  connectionRule,
  type ConnectionRule,
  type ConnectionRuleTable,
} from "../scenarioConnectionRules";
import { validateScenarioGraph } from "../scenarioGraphValidator";

const node = (id: string, type = "delay", data?: Record<string, unknown>) => ({
  id,
  type,
  ...(data ? { data } : {}),
});
const edge = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}>${target}${sourceHandle ? `:${sourceHandle}` : ""}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});
const codes = (def: Parameters<typeof validateScenarioGraph>[0]) =>
  validateScenarioGraph(def).map((i) => i.code);
/** The issues of `START → n` (n a node with id "n"). */
const issuesAfterStart = (n: ReturnType<typeof node>) =>
  validateScenarioGraph({
    nodes: [node("s", "start"), n],
    edges: [edge("s", "n")],
  });

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

  // The executor starts from the origin only; another START runs as a step,
  // first edge only, and only when an edge reaches it (ScenarioExecutor
  // permissive test "ignores a second START").
  it("starts nothing from a second START", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s1", "start"), node("a"), node("s2", "start"), node("b")],
        edges: [edge("s1", "a"), edge("s2", "b")],
      }),
    ).toEqual([
      { code: "multipleStart", nodeId: "s2", severity: "warning" },
      { code: "unreachable", nodeId: "b", severity: "warning" },
    ]);
    // Reached by an edge, it runs as a step: on along its first edge only.
    expect(
      validateScenarioGraph({
        nodes: [node("s1", "start"), node("s2", "start"), node("a"), node("b")],
        edges: [edge("s1", "s2"), edge("s2", "a"), edge("s2", "b")],
      }),
    ).toEqual([
      { code: "multipleStart", nodeId: "s2", severity: "warning" },
      { code: "extraOutgoing", nodeId: "s2", severity: "warning" },
    ]);
    // Its edges hand the branch no fresh CALL slot.
    expect(
      codes({
        nodes: [
          node("s1", "start"),
          node("t", "csmsCallTrigger", {
            action: "Reset",
            behavior: "replace",
          }),
          node("s2", "start"),
          node("r", "callResponse", { kind: "result" }),
        ],
        edges: [edge("s1", "t"), edge("t", "s2"), edge("s2", "r")],
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
      node("sw", "switch", { value: 0, cases: [0] }),
      node("a"),
      node("b"),
      node("e", "end"),
    ];
    const edges = [
      edge("s", "sw"),
      edge("sw", "a", "case-0"),
      edge("sw", "b", "default"),
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
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("c", "choice", { options: [{}, {}] }),
          node("a"),
          node("b"),
        ],
        edges: [
          edge("s", "c"),
          edge("c", "a", "option-0"),
          edge("c", "b", "option-1"),
        ],
      }),
    ).toEqual([]);
  });

  it("follows every handle of a switch when it checks the CALL", () => {
    const nodes = [
      node("s", "start"),
      node("sw", "switch", { value: 0, cases: [0] }),
      node("ok", "callResponse", { kind: "result" }),
      node("other"),
    ];
    // Both handles lead on without a CALL: the callResponse one cannot run.
    expect(
      codes({
        nodes,
        edges: [
          edge("s", "sw"),
          edge("sw", "ok", "case-0"),
          edge("sw", "other", "default"),
        ],
      }),
    ).toEqual(["noCallHeld"]);
  });

  // executeSwitch / executeChoice always set flow.handle and nextStep keeps
  // only the edges with it: an edge without a handle, or with one the node
  // cannot pick, never runs.
  it("never follows a switch / choice edge whose handle the node cannot pick", () => {
    const respond = node("r", "callResponse", { kind: "result" });
    expect(
      validateScenarioGraph({
        nodes: [
          node("s", "start"),
          node("sw", "switch", { value: 0, cases: [0] }),
          respond,
        ],
        edges: [edge("s", "sw"), edge("sw", "r")],
      }),
    ).toEqual([
      {
        code: "unpickableHandle",
        nodeId: "sw",
        edgeId: "sw>r",
        severity: "warning",
      },
      { code: "unreachable", nodeId: "r", severity: "warning" },
    ]);
    const unpickable = (
      sw: ReturnType<typeof node>,
      handle: string,
    ): string[] =>
      codes({
        nodes: [node("s", "start"), sw, node("a")],
        edges: [edge("s", sw.id), edge(sw.id, "a", handle)],
      });
    const sw = node("sw", "switch", { value: 0, cases: [0, 1] });
    expect(unpickable(sw, "case-1")).toEqual([]);
    expect(unpickable(sw, "default")).toEqual([]);
    expect(unpickable(sw, "case-2")).toEqual([
      "unpickableHandle",
      "unreachable",
    ]);
    expect(unpickable(sw, "option-0")).toEqual([
      "unpickableHandle",
      "unreachable",
    ]);
    const choice = node("c", "choice", { options: [{}, { weight: 2 }] });
    expect(unpickable(choice, "option-1")).toEqual([]);
    expect(unpickable(choice, "option-2")).toEqual([
      "unpickableHandle",
      "unreachable",
    ]);
    expect(unpickable(choice, "default")).toEqual([
      "unpickableHandle",
      "unreachable",
    ]);
    // A choice that fails the run before it picks picks nothing.
    expect(
      unpickable(node("c", "choice", { options: [{}] }), "option-0"),
    ).toEqual(["unpickableHandle", "unreachable"]);
  });

  it("follows only the first edge of a handle when it checks the CALL", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("sw", "switch", { value: 0, cases: [] }),
          node("a"),
          node("r", "callResponse", { kind: "result" }),
        ],
        edges: [
          edge("s", "sw"),
          edge("sw", "a", "default"),
          edge("sw", "r", "default"),
        ],
      }),
      // No CALL issue: `r` is behind the second `default` edge, never taken.
      // That edge is reported, and `r` (reached only through it) is too.
    ).toEqual(["duplicateHandle", "unreachable"]);
  });

  it("reports every later edge of a handle and follows only the first", () => {
    const issues = validateScenarioGraph({
      nodes: [
        node("s", "start"),
        node("sw", "switch", { value: 0, cases: [0] }),
        node("a"),
        node("b"),
        node("c"),
        node("d"),
      ],
      edges: [
        edge("s", "sw"),
        edge("sw", "a", "case-0"),
        edge("sw", "b", "case-0"),
        edge("sw", "c", "default"),
        edge("sw", "d", "case-0"),
        // c → b: b is still reachable, but not through sw's second case-0.
        edge("c", "b"),
      ],
    });
    expect(issues).toEqual([
      {
        code: "duplicateHandle",
        nodeId: "sw",
        edgeId: "sw>b:case-0",
        severity: "warning",
        data: { handle: "case-0" },
      },
      {
        code: "duplicateHandle",
        nodeId: "sw",
        edgeId: "sw>d:case-0",
        severity: "warning",
        data: { handle: "case-0" },
      },
      { code: "unreachable", nodeId: "d", severity: "warning" },
    ]);
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

  // executeSwitch / executeSetState / executeNotify resolve these fields
  // through fromScope(flow) like ocppCall's payload: a call.* path throws
  // without a CALL.
  describe.each([
    ["switch", (from: unknown) => ({ value: from, cases: [1] })],
    ["setState", (from: unknown) => ({ key: "k", value: from })],
    [
      "notify",
      (from: unknown) => ({
        kind: "firmwareStatus",
        status: "Installed",
        requestId: from,
      }),
    ],
  ] as const)("a $from in %s", (type, dataOf) => {
    // A switch with one case leaves by `case-0` or `default`.
    const out = type === "switch" ? "default" : undefined;
    const reader = (path: string) => node("n", type, dataOf({ $from: path }));

    it("needs a CALL on the call root", () => {
      expect(
        connectionRule(type).call(dataOf({ $from: "call.messageId" })),
      ).toBe("reads");
      expect(issuesAfterStart(reader("call.payload.requestId"))).toEqual([
        { code: "noCallHeld", nodeId: "n", severity: "error" },
      ]);
    });

    it("needs none on the state and charger roots", () => {
      expect(issuesAfterStart(reader("state.x"))).toEqual([]);
      expect(issuesAfterStart(reader("charger.status"))).toEqual([]);
    });

    it("is fine after a replace trigger", () => {
      expect(
        validateScenarioGraph({
          nodes: [
            node("s", "start"),
            node("t", "csmsCallTrigger", {
              action: "Reset",
              behavior: "replace",
            }),
            reader("call.payload.requestId"),
            node("r", "callResponse", { kind: "result" }),
          ],
          edges: [edge("s", "t"), edge("t", "n"), edge("n", "r", out)],
        }),
      ).toEqual([]);
    });
  });
});

// Schema 1.7: the answer to an ocppCall that a branch holds (`response`).
describe("a $from on the response root", () => {
  const call = (id: string, payload?: unknown) =>
    node(id, "ocppCall", { action: "Authorize", payload });
  const sw = (id: string) =>
    node(id, "switch", {
      value: { $from: "response.kind" },
      cases: ["result"],
    });
  const noHeld = { code: "noResponseHeld", nodeId: "sw", severity: "error" };

  it("is flagged right after START and when no ocppCall precedes it", () => {
    expect(issuesAfterStart(sw("n"))).toEqual([{ ...noHeld, nodeId: "n" }]);
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), node("d"), sw("sw")],
        edges: [edge("s", "d"), edge("d", "sw")],
      }),
    ).toEqual([noHeld]);
  });

  it("is fine after an ocppCall in the same branch, whatever the switch picks", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), call("c"), sw("sw"), node("a"), node("b")],
        edges: [
          edge("s", "c"),
          edge("c", "sw"),
          edge("sw", "a", "case-0"),
          edge("sw", "b", "default"),
        ],
      }),
    ).toEqual([]);
  });

  it("is flagged when only one path through a join has an ocppCall", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), call("c"), node("d"), sw("sw")],
        edges: [
          edge("s", "c"),
          edge("s", "d"),
          edge("c", "sw"),
          edge("d", "sw"),
        ],
      }).map((i) => i.code),
    ).toEqual(["noResponseHeld"]);
  });

  it("an ocppCall payload reads the answer of an earlier call, not its own", () => {
    const reads = call("c2", {
      id: { $from: "response.payload.transactionId" },
    });
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), reads],
        edges: [edge("s", "c2")],
      }).map((i) => i.code),
    ).toEqual(["noResponseHeld"]);
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), call("c1"), reads],
        edges: [edge("s", "c1"), edge("c1", "c2")],
      }),
    ).toEqual([]);
  });

  it("reports setState / notify / callResponse readers and ignores other roots", () => {
    expect(
      connectionRule("setState").response?.({
        key: "k",
        value: { $from: "response.payload.x" },
      } as never),
    ).toEqual({ reads: true, produces: false });
    expect(
      connectionRule("setState").response?.({
        key: "k",
        value: { $from: "state.x" },
      } as never),
    ).toEqual({ reads: false, produces: false });
    expect(connectionRule("delay").response).toBeUndefined();
  });

  it("a node reading both roots gets both diagnostics", () => {
    expect(
      issuesAfterStart(
        node("n", "setState", {
          key: "k",
          value: {
            a: { $from: "call.payload.x" },
            b: { $from: "response.kind" },
          },
        }),
      ).map((i) => i.code),
    ).toEqual(["noCallHeld", "noResponseHeld"]);
  });
});

// Schema 1.7: $match cases of a switch.
describe("switch $match case diagnostics", () => {
  const withCases = (cases: unknown[]) =>
    validateScenarioGraph({
      nodes: [
        node("s", "start"),
        node("sw", "switch", { value: 1, cases }),
        ...cases.map((_, i) => node(`t${i}`)),
      ],
      edges: [
        edge("s", "sw"),
        ...cases.map((_, i) => edge("sw", `t${i}`, `case-${i}`)),
      ],
    });

  it("is quiet for well-formed matchers", () => {
    expect(
      withCases([
        "Accepted",
        { $match: { in: ["Blocked", "Invalid"] } },
        { $match: { gte: 20, lt: 80 } },
        { $match: { not: { equals: "Charging" } } },
        { $match: { exists: false } },
      ]),
    ).toEqual([]);
  });

  it("warns on an unknown operator with the case's handle", () => {
    expect(withCases(["a", { $match: { regex: "x" } }])).toEqual([
      {
        code: "unknownMatcher",
        nodeId: "sw",
        severity: "warning",
        data: { handle: "case-1", operator: "regex" },
      },
    ]);
  });

  it("warns on a badly typed argument, an empty $match and a nested not", () => {
    const found = withCases([
      { $match: { in: "Blocked" } },
      { $match: {} },
      { $match: { not: { not: { equals: 1 } } } },
    ]);
    expect(found.map((i) => [i.code, i.data])).toEqual([
      ["badMatcherArgument", { handle: "case-0", operator: "in" }],
      ["badMatcherArgument", { handle: "case-1", operator: "" }],
      ["badMatcherArgument", { handle: "case-2", operator: "not" }],
    ]);
  });

  it("leaves a $match beside other keys alone: it is a constant", () => {
    expect(withCases([{ $match: { regex: "x" }, other: 1 }])).toEqual([]);
  });

  it("warns on a case identical to an earlier one", () => {
    expect(
      withCases([{ $match: { gte: 80 } }, "x", { $match: { gte: 80 } }]),
    ).toEqual([
      {
        code: "unreachableCase",
        nodeId: "sw",
        severity: "warning",
        data: { handle: "case-2", shadowedBy: "case-0" },
      },
    ]);
  });

  it("warns on every case after an always-true matcher, except a missing-only one", () => {
    const found = withCases([
      { $match: { exists: true } },
      "x",
      { $match: { gte: 1 } },
      { $match: { exists: false } },
    ]);
    expect(found.map((i) => [i.code, i.data?.handle])).toEqual([
      ["unreachableCase", "case-1"],
      ["unreachableCase", "case-2"],
    ]);
    expect(
      withCases([{ $match: { not: { exists: false } } }, "x"]).map(
        (i) => i.code,
      ),
    ).toEqual(["unreachableCase"]);
  });

  it("does not call a narrowing matcher always-true", () => {
    expect(withCases([{ $match: { exists: true, gte: 1 } }, "x"])).toEqual([]);
  });
});

describe("validateScenarioGraph: timeout edges (schema 1.8)", () => {
  const timeout = (source: string, target: string) => ({
    ...edge(source, target),
    id: `${source}~>${target}`,
    kind: "timeout",
  });
  const wait = (id: string, seconds?: number) =>
    node(id, "statusTrigger", {
      targetStatus: "Charging",
      ...(seconds === undefined ? {} : { timeout: seconds }),
    });

  it("marks the six trigger waits, and only them", () => {
    const waits = Object.values(ScenarioNodeType).filter(
      (type) => connectionRule(type).waits,
    );
    expect(waits.sort()).toEqual(
      [
        "connectionTrigger",
        "csmsCallTrigger",
        "remoteStartTrigger",
        "remoteStopTrigger",
        "reservationTrigger",
        "statusTrigger",
      ].sort(),
    );
  });

  it("a timeout edge out of a wait that can expire is clean, and reaches its target", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), wait("w", 5), node("late")],
        edges: [edge("s", "w"), timeout("w", "late")],
      }),
    ).toEqual([]);
    // It does not count as a second ordinary edge (no extraOutgoing).
    expect(
      codes({
        nodes: [node("s", "start"), wait("w", 5), node("a"), node("late")],
        edges: [edge("s", "w"), edge("w", "a"), timeout("w", "late")],
      }),
    ).toEqual([]);
  });

  it("timeoutEdgeOnNonWait: out of a step, out of Start, out of a wait labelled End", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), node("d"), node("late")],
        edges: [edge("s", "d"), timeout("d", "late")],
      }),
    ).toEqual([
      {
        code: "timeoutEdgeOnNonWait",
        nodeId: "d",
        edgeId: "d~>late",
        severity: "warning",
      },
      // Never followed, so its target is unreachable.
      { code: "unreachable", nodeId: "late", severity: "warning" },
    ]);
    expect(
      codes({
        nodes: [node("s", "start"), node("a")],
        edges: [edge("s", "a"), timeout("s", "a")],
      }),
    ).toEqual(["timeoutEdgeOnNonWait"]);
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("w", "statusTrigger", { label: "End", timeout: 5 }),
          node("late"),
        ],
        edges: [edge("s", "w"), timeout("w", "late")],
      }),
    ).toEqual(["timeoutEdgeOnNonWait", "unreachable"]);
  });

  it("timeoutEdgeNeverFires (info): a wait without a timeout never expires", () => {
    for (const seconds of [undefined, 0]) {
      expect(
        validateScenarioGraph({
          nodes: [node("s", "start"), wait("w", seconds), node("late")],
          edges: [edge("s", "w"), timeout("w", "late")],
        }),
      ).toEqual([
        {
          code: "timeoutEdgeNeverFires",
          nodeId: "w",
          edgeId: "w~>late",
          severity: "info",
        },
        { code: "unreachable", nodeId: "late", severity: "warning" },
      ]);
    }
  });

  it("extraTimeoutEdge: only the first one runs", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), wait("w", 5), node("a"), node("b")],
        edges: [edge("s", "w"), timeout("w", "a"), timeout("w", "b")],
      }),
    ).toEqual([
      {
        code: "extraTimeoutEdge",
        nodeId: "w",
        edgeId: "w~>b",
        severity: "warning",
      },
      { code: "unreachable", nodeId: "b", severity: "warning" },
    ]);
  });

  it("newerConstruct (info) when the file declares a version below 1.8", () => {
    const def = {
      nodes: [node("s", "start"), wait("w", 5), node("late")],
      edges: [edge("s", "w"), timeout("w", "late")],
    };
    expect(validateScenarioGraph({ ...def, schemaVersion: "1.6" })).toEqual([
      {
        code: "newerConstruct",
        edgeId: "w~>late",
        severity: "info",
        data: { since: "1.8", declared: "1.6" },
      },
    ]);
    for (const schemaVersion of ["1.8", "1.10", "2.0", undefined, "x"]) {
      expect(codes({ ...def, schemaVersion }), String(schemaVersion)).toEqual(
        [],
      );
    }
    // Without a timeout edge the version is never looked at.
    expect(
      codes({
        nodes: [node("s", "start"), node("a")],
        edges: [edge("s", "a")],
        schemaVersion: "1.0",
      }),
    ).toEqual([]);
  });

  it("an edge with another kind is an ordinary edge", () => {
    expect(
      codes({
        nodes: [node("s", "start"), node("a"), node("b")],
        edges: [edge("s", "a"), { ...edge("a", "b"), kind: "other" }],
      }),
    ).toEqual([]);
  });

  it("the CALL analysis leaves a timed-out replace trigger with the state before it", () => {
    const replace = node("t", "csmsCallTrigger", {
      action: "Reset",
      behavior: "replace",
      timeout: 5,
    });
    const respond = node("r", "callResponse", { kind: "result" });
    // After a timeout nothing was taken over: the callResponse may run
    // without a CALL.
    expect(
      codes({
        nodes: [node("s", "start"), replace, respond],
        edges: [edge("s", "t"), edge("t", "r"), timeout("t", "r")],
      }),
    ).toEqual(["noCallHeld"]);
    // Without a timeout the edge never runs, and the path is clean.
    expect(
      codes({
        nodes: [
          node("s", "start"),
          { ...replace, data: { action: "Reset", behavior: "replace" } },
          respond,
        ],
        edges: [edge("s", "t"), edge("t", "r"), timeout("t", "r")],
      }),
    ).toEqual(["timeoutEdgeNeverFires"]);
    // A CALL held before a wait is still held on its timeout path.
    expect(
      codes({
        nodes: [
          node("s", "start"),
          {
            ...replace,
            id: "t0",
            data: { action: "Reset", behavior: "replace" },
          },
          wait("w", 5),
          respond,
          node("other"),
        ],
        edges: [
          edge("s", "t0"),
          edge("t0", "w"),
          edge("w", "other"),
          timeout("w", "r"),
        ],
      }),
    ).toEqual(["callLeftOpen"]);
  });
});

describe("validateScenarioGraph: parallel and join (schema 1.9)", () => {
  const replace = (id: string) =>
    node(id, "csmsCallTrigger", { action: "Reset", behavior: "replace" });
  const respond = (id: string) => node(id, "callResponse", { kind: "result" });

  it("a parallel forks; a join leaves by its first edge", () => {
    expect(connectionRule("parallel").out).toBe("fork");
    expect(connectionRule("join").out).toBe("next");
  });

  it("a parallel whose branches meet at a join is clean, with no extraOutgoing", () => {
    expect(
      validateScenarioGraph({
        nodes: [
          node("s", "start"),
          node("p", "parallel"),
          node("a"),
          node("b"),
          node("j", "join"),
          node("after"),
        ],
        edges: [
          edge("s", "p"),
          edge("p", "a"),
          edge("p", "b"),
          edge("a", "j"),
          edge("b", "j"),
          edge("j", "after"),
        ],
      }),
    ).toEqual([]);
  });

  it("nested parallels meet at their own joins", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("p1", "parallel"),
          node("p2", "parallel"),
          node("a"),
          node("b"),
          node("j2", "join"),
          node("c"),
          node("j1", "join"),
        ],
        edges: [
          edge("s", "p1"),
          edge("p1", "p2"),
          edge("p1", "c"),
          edge("p2", "a"),
          edge("p2", "b"),
          edge("a", "j2"),
          edge("b", "j2"),
          edge("j2", "j1"),
          edge("c", "j1"),
        ],
      }),
    ).toEqual([]);
  });

  it("joinWithoutParallel (warning) and parallelWithoutJoin (info)", () => {
    expect(
      validateScenarioGraph({
        nodes: [node("s", "start"), node("a"), node("j", "join")],
        edges: [edge("s", "a"), edge("a", "j")],
      }),
    ).toEqual([
      { code: "joinWithoutParallel", nodeId: "j", severity: "warning" },
    ]);
    expect(
      validateScenarioGraph({
        nodes: [
          node("s", "start"),
          node("p", "parallel"),
          node("a"),
          node("b"),
        ],
        edges: [edge("s", "p"), edge("p", "a"), edge("p", "b")],
      }),
    ).toEqual([{ code: "parallelWithoutJoin", nodeId: "p", severity: "info" }]);
  });

  it("a join resets the CALL: callLeftOpen for one still open on arrival, noCallHeld after it", () => {
    expect(
      validateScenarioGraph({
        nodes: [
          node("s", "start"),
          node("p", "parallel"),
          replace("t"),
          node("j", "join"),
          respond("r"),
        ],
        edges: [edge("s", "p"), edge("p", "t"), edge("t", "j"), edge("j", "r")],
      }),
    ).toEqual([
      { code: "callLeftOpen", nodeId: "t", severity: "warning" },
      { code: "noCallHeld", nodeId: "r", severity: "error" },
    ]);
  });

  it("each branch of a parallel starts with a fresh CALL slot; the CALL held at the fork is dropped", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          replace("t"),
          node("p", "parallel"),
          respond("r"),
          node("j", "join"),
        ],
        edges: [edge("s", "t"), edge("t", "p"), edge("p", "r"), edge("r", "j")],
      }).sort(),
    ).toEqual(["callLeftOpen", "noCallHeld"]);
  });

  it("reaches the nodes after a join", () => {
    expect(
      codes({
        nodes: [
          node("s", "start"),
          node("p", "parallel"),
          node("a"),
          node("j", "join", { mode: "any" }),
          node("after"),
        ],
        edges: [
          edge("s", "p"),
          edge("p", "a"),
          edge("a", "j"),
          edge("j", "after"),
        ],
      }),
    ).toEqual([]);
  });

  it("newerConstruct (info) for a parallel or join in a file below 1.9", () => {
    const def = {
      nodes: [node("s", "start"), node("p", "parallel"), node("j", "join")],
      edges: [edge("s", "p"), edge("p", "j")],
    };
    expect(validateScenarioGraph({ ...def, schemaVersion: "1.8" })).toEqual([
      {
        code: "newerConstruct",
        nodeId: "p",
        severity: "info",
        data: { since: "1.9", declared: "1.8" },
      },
    ]);
    expect(codes({ ...def, schemaVersion: "1.9" })).toEqual([]);
  });
});
