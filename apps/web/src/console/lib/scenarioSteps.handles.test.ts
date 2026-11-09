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

  it("gives a new lane of a switch the next free handle", () => {
    const def = switchScenario();
    const out = addParallelBranch(def, deriveStepLayout(def));
    const handles = out.edges
      .filter((e) => e.source === "sw")
      .map((e) => e.sourceHandle);
    expect(handles).toEqual(["case-0", "case-1", "default", "default"]);
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

  it("wires a choice in a chain to option-0", () => {
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
    expect(out.edges.find((e) => e.source === "ch")?.sourceHandle).toBe(
      "option-0",
    );
  });
});
