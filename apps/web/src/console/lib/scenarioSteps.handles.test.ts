import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { forkScenario } from "../test/scenarioFixtures";
import {
  addParallelBranch,
  createEmptyScenario,
  insertLaneStep,
  insertStep,
  removeLaneStep,
} from "./scenarioSteps";
import { deriveStepLayout } from "./stepLayout";

const delay = (id: string): ScenarioNode =>
  ({
    id,
    type: ScenarioNodeType.DELAY,
    position: { x: 0, y: 0 },
    data: { label: id, delaySeconds: 1 },
  }) as ScenarioNode;

/** START → sw (switch, two cases) → { case-0: a, case-1: b, default: c }. */
function switchScenario(): ScenarioDefinition {
  const base = forkScenario();
  const find = (type: ScenarioNodeType) =>
    base.nodes.find((n) => n.type === type)!;
  const sw = {
    id: "sw",
    type: ScenarioNodeType.SWITCH,
    position: { x: 0, y: 0 },
    data: { label: "sw", value: 1, cases: [1, 2] },
  } as ScenarioNode;
  return {
    ...base,
    nodes: [
      { ...find(ScenarioNodeType.START), id: "start" },
      sw,
      delay("a"),
      delay("b"),
      delay("c"),
      { ...find(ScenarioNodeType.END), id: "end" },
    ],
    edges: [
      { id: "e0", source: "start", target: "sw" },
      { id: "e1", source: "sw", target: "a", sourceHandle: "case-0" },
      { id: "e2", source: "sw", target: "b", sourceHandle: "case-1" },
      { id: "e3", source: "sw", target: "c", sourceHandle: "default" },
      { id: "e4", source: "a", target: "end" },
      { id: "e5", source: "b", target: "end" },
      { id: "e6", source: "c", target: "end" },
    ],
  } as ScenarioDefinition;
}

const handleTo = (def: ScenarioDefinition, source: string, target: string) =>
  def.edges.find((e) => e.source === source && e.target === target)
    ?.sourceHandle;

describe("switch / choice handles survive the list editor (#822 review)", () => {
  it("keeps case-<n> and default when a step is inserted into a lane", () => {
    const def = switchScenario();
    const layout = deriveStepLayout(def);
    expect(layout.supported).toBe(true);
    const out = insertLaneStep(def, layout, 0, 0, ScenarioNodeType.DELAY);
    const newFirst = deriveStepLayout(out).fork!.branches[0].steps[0].id;
    expect(newFirst).not.toBe("a");
    expect(handleTo(out, "sw", newFirst)).toBe("case-0");
    expect(handleTo(out, "sw", "b")).toBe("case-1");
    expect(handleTo(out, "sw", "c")).toBe("default");
  });

  it("keeps the handles of the other lanes when a lane is dropped", () => {
    const def = switchScenario();
    const out = removeLaneStep(def, deriveStepLayout(def), "a");
    expect(handleTo(out, "sw", "b")).toBe("case-1");
    expect(handleTo(out, "sw", "c")).toBe("default");
  });

  it("leaves a new lane without a handle when the switch has none free", () => {
    const def = switchScenario();
    const out = addParallelBranch(def, deriveStepLayout(def));
    const handles = out.edges
      .filter((e) => e.source === "sw")
      .map((e) => e.sourceHandle);
    // Never a second `default`: only the first of two edges would run.
    expect(handles).toEqual(["case-0", "case-1", "default", undefined]);
  });

  it("wires a switch placed in the console so the run can leave it", () => {
    const placed = insertStep(
      createEmptyScenario("s", "chargePoint"),
      0,
      ScenarioNodeType.SWITCH,
    );
    const sw = placed.nodes.find((n) => n.type === ScenarioNodeType.SWITCH)!;
    const out = insertStep(placed, 1, ScenarioNodeType.DELAY);
    expect(out.edges.find((e) => e.source === sw.id)?.sourceHandle).toBe(
      "default",
    );
  });

  it("keeps a choice's single edge without a handle in a chain", () => {
    const def = switchScenario();
    const choice = {
      id: "ch",
      type: ScenarioNodeType.CHOICE,
      position: { x: 0, y: 0 },
      data: { label: "ch", options: [{ weight: 1 }] },
    } as ScenarioNode;
    const chain = {
      ...def,
      nodes: [def.nodes[0], choice, delay("a"), def.nodes[5]],
      edges: [
        { id: "x0", source: "start", target: "ch" },
        { id: "x1", source: "ch", target: "a" },
        { id: "x2", source: "a", target: "end" },
      ],
    } as ScenarioDefinition;
    const out = insertStep(chain, 2, ScenarioNodeType.DELAY);
    // The file's ch → a never runs; the editor does not make it run.
    const edge = out.edges.find((e) => e.source === "ch")!;
    expect(edge.id).toBe("x1");
    expect("sourceHandle" in edge).toBe(false);
  });
});

const node = (
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown> = {},
): ScenarioNode =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  }) as ScenarioNode;

/** START → sel, then one edge per `[target, sourceHandle]` out of `sel`;
 *  each target is a Delay that runs to END (a target `end` is END itself). */
function selectScenario(
  sel: ScenarioNode,
  lanes: Array<[string, string | undefined]>,
): ScenarioDefinition {
  const targets = lanes.map(([t]) => t).filter((t) => t !== "end");
  return {
    ...forkScenario(),
    nodes: [
      node("start", ScenarioNodeType.START),
      sel,
      ...targets.map((t) => delay(t)),
      node("end", ScenarioNodeType.END),
    ],
    edges: [
      { id: "e-start", source: "start", target: sel.id },
      ...lanes.map(([target, handle], i) => ({
        id: `e-sel-${i}`,
        source: sel.id,
        target,
        ...(handle === undefined ? {} : { sourceHandle: handle }),
      })),
      ...targets.map((t) => ({ id: `e-${t}-end`, source: t, target: "end" })),
    ],
  } as ScenarioDefinition;
}

const oneCaseSwitch = () =>
  node("sw", ScenarioNodeType.SWITCH, { value: "a", cases: ["a"] });

const edgesFrom = (def: ScenarioDefinition, source: string) =>
  def.edges
    .filter((e) => e.source === source)
    .map((e) => [e.target, e.sourceHandle]);

describe("the editor keeps every existing edge's handle, or its absence", () => {
  it("keeps a switch edge without a handle dead when a lane gets a step", () => {
    // The browser repro: sw → d1 has no handle, the executor never takes it.
    const def = selectScenario(oneCaseSwitch(), [
      ["n1", "case-0"],
      ["st", "default"],
      ["d1", undefined],
    ]);
    const layout = deriveStepLayout(def);
    expect(layout.fork!.branches.map((b) => b.handle)).toEqual([
      "case-0",
      "default",
      null,
    ]);
    const out = insertLaneStep(def, layout, 0, 1, ScenarioNodeType.DELAY);
    expect(edgesFrom(out, "sw")).toEqual([
      ["n1", "case-0"],
      ["st", "default"],
      ["d1", undefined],
    ]);
    const d1 = out.edges.find((e) => e.source === "sw" && e.target === "d1")!;
    expect("sourceHandle" in d1).toBe(false);
  });

  it("gives a step put first in a lane without a handle none either", () => {
    const def = selectScenario(oneCaseSwitch(), [
      ["n1", "case-0"],
      ["st", "default"],
      ["d1", undefined],
    ]);
    const out = insertLaneStep(
      def,
      deriveStepLayout(def),
      2,
      0,
      ScenarioNodeType.DELAY,
    );
    const handles = edgesFrom(out, "sw").map(([, h]) => h);
    expect(handles).toEqual(["case-0", "default", undefined]);
  });

  it("keeps default on the remaining lane when the case-0 lane goes", () => {
    const def = selectScenario(oneCaseSwitch(), [
      ["n1", "case-0"],
      ["st", "default"],
    ]);
    const out = removeLaneStep(def, deriveStepLayout(def), "n1");
    expect(edgesFrom(out, "sw")).toEqual([["st", "default"]]);
  });

  it("keeps case-1 on the remaining lane, not a handle of its new index", () => {
    const sw = node("sw", ScenarioNodeType.SWITCH, { value: 1, cases: [1, 2] });
    const def = selectScenario(sw, [
      ["a", "case-0"],
      ["b", "case-1"],
    ]);
    const out = removeLaneStep(def, deriveStepLayout(def), "a");
    expect(edgesFrom(out, "sw")).toEqual([["b", "case-1"]]);
    // Still so after a step lands between sw and b in the folded chain.
    const again = insertLaneStep(
      out,
      deriveStepLayout(out),
      "main",
      1,
      ScenarioNodeType.DELAY,
    );
    expect(edgesFrom(again, "sw").map(([, h]) => h)).toEqual(["case-1"]);
  });

  it("keeps each lane's handle when two lanes share a pair", () => {
    // Two empty lanes, both sw → END: the lane that gets a step keeps case-0,
    // the other keeps default.
    const def = selectScenario(oneCaseSwitch(), [
      ["end", "default"],
      ["end", "case-0"],
    ]);
    const layout = deriveStepLayout(def);
    expect(layout.fork!.branches.map((b) => b.handle)).toEqual([
      "default",
      "case-0",
    ]);
    const out = insertLaneStep(def, layout, 1, 0, ScenarioNodeType.DELAY);
    const fresh = deriveStepLayout(out).fork!.branches[1].steps[0].id;
    expect(edgesFrom(out, "sw")).toEqual([
      ["end", "default"],
      [fresh, "case-0"],
    ]);
    expect(
      out.edges.find((e) => e.target === "end" && e.source === "sw")!.id,
    ).toBe("e-sel-0");
  });

  it("gives a new lane on a one-case switch case-0, then default, then none", () => {
    const newHandle = (lanes: Array<[string, string | undefined]>) => {
      const def = selectScenario(oneCaseSwitch(), lanes);
      const out = addParallelBranch(def, deriveStepLayout(def));
      const handles = edgesFrom(out, "sw").map(([, h]) => h);
      expect(handles.slice(0, lanes.length)).toEqual(lanes.map(([, h]) => h));
      return handles[lanes.length];
    };
    expect(
      newHandle([
        ["a", "default"],
        ["b", undefined],
      ]),
    ).toBe("case-0");
    expect(
      newHandle([
        ["a", "case-0"],
        ["b", undefined],
      ]),
    ).toBe("default");
    expect(
      newHandle([
        ["a", "case-0"],
        ["b", "default"],
      ]),
    ).toBeUndefined();
  });

  it("gives a new lane on a choice the first free option-<i>", () => {
    const ch = node("ch", ScenarioNodeType.CHOICE, {
      options: [{}, {}, {}],
    });
    const def = selectScenario(ch, [
      ["a", "option-0"],
      ["b", "option-2"],
    ]);
    const out = addParallelBranch(def, deriveStepLayout(def));
    expect(edgesFrom(out, "ch").map(([, h]) => h)).toEqual([
      "option-0",
      "option-2",
      "option-1",
    ]);
  });

  it("keeps a switch's single edge without a handle", () => {
    const def = selectScenario(oneCaseSwitch(), [["a", undefined]]);
    const layout = deriveStepLayout(def);
    expect(layout.fork).toBeNull();
    for (const out of [
      insertLaneStep(def, layout, "main", 1, ScenarioNodeType.DELAY),
      insertLaneStep(def, layout, "main", 2, ScenarioNodeType.DELAY),
      insertStep(def, 1, ScenarioNodeType.DELAY),
      insertStep(def, 2, ScenarioNodeType.DELAY),
    ]) {
      const fromSw = out.edges.filter((e) => e.source === "sw");
      expect(fromSw).toHaveLength(1);
      expect("sourceHandle" in fromSw[0]).toBe(false);
    }
  });

  it("keeps a chain's no-handle continuation as a lane and picks for the new one", () => {
    const def = selectScenario(oneCaseSwitch(), [["a", undefined]]);
    const chain = {
      ...def,
      // sw is the last step: sw → END, without a handle.
      nodes: def.nodes.filter((n) => n.id !== "a"),
      edges: [def.edges[0], { id: "e-sw-end", source: "sw", target: "end" }],
    } as ScenarioDefinition;
    const out = addParallelBranch(chain, deriveStepLayout(chain));
    const handles = edgesFrom(out, "sw").map(([, h]) => h);
    expect(handles).toEqual([undefined, "case-0"]);
  });
});
