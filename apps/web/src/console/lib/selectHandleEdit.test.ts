import { describe, expect, it } from "vitest";

import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import {
  type ScenarioDefinition,
  type ScenarioNode,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  appendItem,
  moveItem,
  removeItem,
} from "../../components/scenario/forms/scenarioValue";
import {
  applyChoiceOptionEdit,
  applySwitchCaseEdit,
  edgesRemovedBy,
} from "./selectHandleEdit";
import { deriveStepLayout } from "./stepLayout";

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

const stamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** START → route (switch on state.mode, cases a / b / c) ┬ case-0 → stepA → END
 *                                                         ├ case-1 → stepB → END
 *                                                         ├ default → stepD → END
 *  (case-2 has no lane yet) */
function switchScenario(): ScenarioDefinition {
  return {
    id: "sw",
    name: "Switch",
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START),
      node("route", ScenarioNodeType.SWITCH, {
        value: { $from: "connector.status" },
        cases: ["a", "b", "c"],
      }),
      node("stepA", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepB", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("stepD", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "route" },
      {
        id: "e-a",
        source: "route",
        target: "stepA",
        sourceHandle: "case-0",
        type: "smoothstep",
      },
      { id: "e-b", source: "route", target: "stepB", sourceHandle: "case-1" },
      {
        id: "e-d",
        source: "route",
        target: "stepD",
        sourceHandle: "default",
      },
      { id: "e-a-end", source: "stepA", target: "end" },
      { id: "e-b-end", source: "stepB", target: "end" },
      { id: "e-d-end", source: "stepD", target: "end" },
    ],
    ...stamps,
  };
}

/** START → pick (choice of 3) → one / two / three → END */
function choiceScenario(): ScenarioDefinition {
  return {
    id: "ch",
    name: "Choice",
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START),
      node("pick", ScenarioNodeType.CHOICE, {
        options: [
          { weight: 1, label: "one" },
          { weight: 2, label: "two" },
          { weight: 3, label: "three" },
        ],
      }),
      node("one", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("two", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("three", ScenarioNodeType.DELAY, { delaySeconds: 1 }),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: "pick" },
      { id: "e-1", source: "pick", target: "one", sourceHandle: "option-0" },
      { id: "e-2", source: "pick", target: "two", sourceHandle: "option-1" },
      { id: "e-3", source: "pick", target: "three", sourceHandle: "option-2" },
      { id: "e-1-end", source: "one", target: "end" },
      { id: "e-2-end", source: "two", target: "end" },
      { id: "e-3-end", source: "three", target: "end" },
    ],
    ...stamps,
  };
}

/** Each lane's first step → what its handle picks it on: the case value
 *  (`default` for default) of a switch, the option label of a choice. */
function lanePicks(
  def: ScenarioDefinition,
  nodeId: string,
): Record<string, unknown> {
  const fork = def.nodes.find((n) => n.id === nodeId)!;
  const data = fork.data as {
    cases?: unknown[];
    options?: Array<{ label?: string }>;
  };
  const picks: Record<string, unknown> = {};
  for (const edge of def.edges.filter((e) => e.source === nodeId)) {
    const handle = edge.sourceHandle ?? "";
    const match = /^(case|option)-(\d+)$/.exec(handle);
    picks[edge.target] = !match
      ? handle
      : match[1] === "case"
        ? data.cases?.[Number(match[2])]
        : data.options?.[Number(match[2])]?.label;
  }
  return picks;
}

/** The validator's handle warnings: the edit must add none. */
const handleIssues = (def: ScenarioDefinition) =>
  validateScenarioGraph(def).filter(
    (i) => i.code === "unpickableHandle" || i.code === "duplicateHandle",
  );

/** Each drawn lane's first step and handle. */
const drawnLanes = (def: ScenarioDefinition) =>
  deriveStepLayout(def).fork?.branches.map((b) => [b.steps[0]?.id, b.handle]);

describe("applySwitchCaseEdit", () => {
  it("moves the lanes with their cases on a reorder", () => {
    const def = switchScenario();
    const cases = (def.nodes[1]!.data as { cases: unknown[] }).cases;
    const { next, mapping } = moveItem(cases, 1, 0);
    const after = applySwitchCaseEdit(def, "route", next, mapping);

    expect(next).toEqual(["b", "a", "c"]);
    expect(lanePicks(after, "route")).toEqual(lanePicks(def, "route"));
    expect(lanePicks(after, "route")).toEqual({
      stepA: "a",
      stepB: "b",
      stepD: "default",
    });
    expect(handleIssues(after)).toEqual([]);
    // Ids, order and fields kept; only the handles change.
    expect(after.edges.map((e) => e.id)).toEqual(def.edges.map((e) => e.id));
    expect(after.edges[1]).toEqual({ ...def.edges[1], sourceHandle: "case-1" });
    expect(after.edges[2]).toEqual({ ...def.edges[2], sourceHandle: "case-0" });
    expect(drawnLanes(after)).toEqual([
      ["stepA", "case-1"],
      ["stepB", "case-0"],
      ["stepD", "default"],
    ]);
  });

  it("removes only the removed case's edge and renumbers the rest", () => {
    const def = switchScenario();
    const cases = (def.nodes[1]!.data as { cases: unknown[] }).cases;
    const { next, mapping } = removeItem(cases, 0);
    expect(edgesRemovedBy(def, "route", "case", mapping)).toEqual(["e-a"]);

    const after = applySwitchCaseEdit(def, "route", next, mapping);
    expect(after.edges.map((e) => e.id)).toEqual(
      def.edges.map((e) => e.id).filter((id) => id !== "e-a"),
    );
    expect(lanePicks(after, "route")).toEqual({
      stepB: "b",
      stepD: "default",
    });
    expect(handleIssues(after)).toEqual([]);
    // The lane's steps stay (now unreachable): only the edge went.
    expect(after.nodes.map((n) => n.id)).toEqual(def.nodes.map((n) => n.id));
  });

  it("removing a case without a lane removes no edge", () => {
    const def = switchScenario();
    const cases = (def.nodes[1]!.data as { cases: unknown[] }).cases;
    const { next, mapping } = removeItem(cases, 2);
    expect(edgesRemovedBy(def, "route", "case", mapping)).toEqual([]);
    const after = applySwitchCaseEdit(def, "route", next, mapping);
    expect(after.edges).toEqual(def.edges);
    expect(drawnLanes(after)).toEqual(drawnLanes(def));
  });

  it("leaves handles it does not own as they are", () => {
    const def = switchScenario();
    def.edges.push(
      { id: "e-far", source: "route", target: "end", sourceHandle: "case-7" },
      { id: "e-zero", source: "route", target: "end", sourceHandle: "case-01" },
      { id: "e-none", source: "route", target: "end" },
    );
    const before = handleIssues(def);
    const cases = (def.nodes[1]!.data as { cases: unknown[] }).cases;
    const { next, mapping } = moveItem(cases, 0, 2);
    const after = applySwitchCaseEdit(def, "route", next, mapping);
    expect(after.edges.slice(-3)).toEqual(def.edges.slice(-3));
    expect(handleIssues(after)).toEqual(before);
    expect(lanePicks(after, "route")).toMatchObject({
      stepA: "a",
      stepB: "b",
    });
  });
});

describe("applyChoiceOptionEdit", () => {
  const options = () =>
    (choiceScenario().nodes[1]!.data as { options: Array<{ label?: string }> })
      .options;

  it("moves the lanes with their options on a reorder", () => {
    const def = choiceScenario();
    const { next, mapping } = moveItem(options(), 2, 0);
    const after = applyChoiceOptionEdit(def, "pick", next, mapping);
    expect(lanePicks(after, "pick")).toEqual({
      one: "one",
      two: "two",
      three: "three",
    });
    expect(handleIssues(after)).toEqual([]);
    expect(after.edges.map((e) => e.id)).toEqual(def.edges.map((e) => e.id));
  });

  it("removes the removed option's edge only", () => {
    const def = choiceScenario();
    const { next, mapping } = removeItem(options(), 1);
    expect(edgesRemovedBy(def, "pick", "option", mapping)).toEqual(["e-2"]);
    const after = applyChoiceOptionEdit(def, "pick", next, mapping);
    expect(lanePicks(after, "pick")).toEqual({ one: "one", three: "three" });
    expect(handleIssues(after)).toEqual([]);
  });
});

describe("adding an item over a handle the file left an edge on (L1)", () => {
  /** cases a / b, and a leftover edge on case-2 (unpickable so far). */
  function withDeadEdge(): ScenarioDefinition {
    const def = switchScenario();
    (def.nodes[1]!.data as { cases: unknown[] }).cases = ["a", "b"];
    def.edges.push({
      id: "e-dead",
      source: "route",
      target: "stepD",
      sourceHandle: "case-2",
    });
    return def;
  }

  it("kept: the edge stays and the new case picks it", () => {
    const def = withDeadEdge();
    const { next, mapping } = appendItem(["a", "b"] as unknown[], "");
    expect(edgesRemovedBy(def, "route", "case", mapping)).toEqual([]);
    const after = applySwitchCaseEdit(def, "route", next, mapping);
    expect(after.edges).toEqual(def.edges);
    expect((after.nodes[1]!.data as { cases: unknown[] }).cases).toEqual([
      "a",
      "b",
      "",
    ]);
  });

  it("detached: that edge alone goes, every other edge stays", () => {
    const def = withDeadEdge();
    def.edges.push({
      id: "e-dead-2",
      source: "route",
      target: "end",
      sourceHandle: "case-2",
    });
    const { next, mapping } = appendItem(["a", "b"] as unknown[], "", true);
    expect(edgesRemovedBy(def, "route", "case", mapping)).toEqual([
      "e-dead",
      "e-dead-2",
    ]);
    const after = applySwitchCaseEdit(def, "route", next, mapping);
    expect(after.edges.map((e) => e.id)).toEqual(
      def.edges
        .map((e) => e.id)
        .filter((id) => id !== "e-dead" && id !== "e-dead-2"),
    );
    expect(after.edges.filter((e) => e.source === "route")).toEqual(
      def.edges.filter(
        (e) => e.source === "route" && !e.id.startsWith("e-dead"),
      ),
    );
  });

  it("works the same for a choice's options", () => {
    const def = choiceScenario();
    def.edges.push({
      id: "e-dead",
      source: "pick",
      target: "end",
      sourceHandle: "option-3",
    });
    const opts = (def.nodes[1]!.data as { options: object[] }).options;
    const { next, mapping } = appendItem(opts, {}, true);
    const after = applyChoiceOptionEdit(def, "pick", next, mapping);
    expect(after.edges.map((e) => e.id)).not.toContain("e-dead");
    expect(after.edges).toHaveLength(def.edges.length - 1);
  });
});
