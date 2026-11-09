import { describe, expect, it } from "vitest";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { forkScenario } from "../test/scenarioFixtures";
import {
  addParallelBranch,
  insertLaneStep,
  insertStep,
  moveLaneStep,
  moveStep,
  rebuildLinearScenario,
  removeLaneStep,
  setLaneLink,
} from "./scenarioSteps";
import { deriveStepLayout } from "./stepLayout";

type Extra = Record<string, unknown>;

/** The edges of `def` as hand-authored files carry them: extra fields. */
function decorated(def: ScenarioDefinition): ScenarioDefinition {
  return {
    ...def,
    edges: def.edges.map((e) => ({
      ...e,
      type: "smoothstep",
      foo: { keep: e.id },
    })) as ScenarioDefinition["edges"],
  };
}

const pair = (def: ScenarioDefinition, source: string, target: string) =>
  def.edges.find((e) => e.source === source && e.target === target);

function expectKept(
  before: ScenarioDefinition,
  after: ScenarioDefinition,
  source: string,
  target: string,
) {
  const a = pair(before, source, target)!;
  const b = pair(after, source, target);
  expect(b, `${source}->${target} still exists`).toBeDefined();
  expect(b!.id).toBe(a.id);
  expect(b!.type).toBe("smoothstep");
  expect((b as Extra).foo).toEqual({ keep: a.id });
}

describe("lane edits keep what the file said about an edge", () => {
  it("insertLaneStep keeps the edges whose pair is unchanged", () => {
    const def = decorated(forkScenario());
    const out = insertLaneStep(
      def,
      deriveStepLayout(def),
      0,
      1,
      ScenarioNodeType.DELAY,
    );
    expectKept(def, out, "start", "plug");
    expectKept(def, out, "status", "charge");
    expectKept(def, out, "meter", "end");
    expectKept(def, out, "wait", "end");
    expect(pair(out, "charge", "meter")).toBeUndefined();
  });

  it("insertLaneStep gives the new pairs a fresh id and no extras", () => {
    const def = decorated(forkScenario());
    const out = insertLaneStep(
      def,
      deriveStepLayout(def),
      0,
      1,
      ScenarioNodeType.DELAY,
    );
    const old = new Set(def.edges.map((e) => e.id));
    const fresh = out.edges.filter((e) => !old.has(e.id));
    expect(fresh.length).toBeGreaterThan(0);
    for (const e of fresh) expect((e as Extra).foo).toBeUndefined();
    expect(new Set(out.edges.map((e) => e.id)).size).toBe(out.edges.length);
  });

  it("removeLaneStep keeps the untouched edges", () => {
    const def = decorated(forkScenario());
    const out = removeLaneStep(def, deriveStepLayout(def), "wait");
    expectKept(def, out, "start", "plug");
    expectKept(def, out, "plug", "status");
  });

  it("moveLaneStep keeps the edges whose pair survives", () => {
    const def = decorated(forkScenario());
    const out = moveLaneStep(def, deriveStepLayout(def), "charge", 1);
    expectKept(def, out, "start", "plug");
  });

  it("addParallelBranch keeps the existing edges", () => {
    const def = decorated(forkScenario());
    const out = addParallelBranch(def, deriveStepLayout(def));
    expectKept(def, out, "start", "plug");
    expectKept(def, out, "plug", "status");
    expectKept(def, out, "meter", "end");
  });

  it("setLaneLink keeps the other edges and a re-opened lane keeps its END edge id", () => {
    const def = decorated(forkScenario());
    const out = setLaneLink(def, deriveStepLayout(def), "meter", "charge");
    expectKept(def, out, "start", "plug");
    expectKept(def, out, "wait", "end");
    expect(pair(out, "meter", "charge")).toBeDefined();
    const back = setLaneLink(out, deriveStepLayout(out), "meter", null);
    expect(pair(back, "meter", "end")).toBeDefined();
  });

  it("keeps sourceHandle and extras on the linear rebuild too", () => {
    const base = forkScenario();
    const def: ScenarioDefinition = {
      ...base,
      nodes: base.nodes.filter((n) =>
        ["start", "plug", "status", "end"].includes(n.id),
      ),
      edges: [
        { id: "x1", source: "start", target: "plug", type: "step" },
        { id: "x2", source: "plug", target: "status", sourceHandle: "h" },
        { id: "x3", source: "status", target: "end" },
      ],
    };
    const out = moveStep(def, 0, 1);
    // plug/status swapped: start->status and status->plug are new pairs;
    // plug->end too. Only pairs that existed keep their id.
    expect(out.edges.map((e) => e.id).filter((i) => i.startsWith("x"))).toEqual(
      [],
    );
    const same = insertStep(def, 2, ScenarioNodeType.DELAY);
    expect(pair(same, "start", "plug")).toMatchObject({
      id: "x1",
      type: "step",
    });
    expect(pair(same, "plug", "status")).toMatchObject({
      id: "x2",
      sourceHandle: "h",
    });
  });

  it("hands out several edges between one pair in order", () => {
    const base = forkScenario();
    const def: ScenarioDefinition = {
      ...base,
      nodes: base.nodes.filter((n) => ["start", "plug", "end"].includes(n.id)),
      edges: [
        { id: "d1", source: "start", target: "plug", type: "a" },
        { id: "d2", source: "start", target: "plug", type: "b" },
        { id: "d3", source: "plug", target: "end" },
      ],
    };
    const plug = def.nodes.find((n) => n.id === "plug")!;
    const out = rebuildLinearScenario(def, [plug]);
    expect(out.edges.filter((e) => e.source === "start")).toHaveLength(1);
    expect(pair(out, "start", "plug")).toMatchObject({ id: "d1", type: "a" });
  });

  it("keeps the content of an edge whose id another pair already uses", () => {
    const base = forkScenario();
    const def: ScenarioDefinition = {
      ...base,
      nodes: base.nodes.filter((n) => ["start", "plug", "end"].includes(n.id)),
      edges: [
        { id: "e", source: "start", target: "plug", type: "x" },
        { id: "e", source: "plug", target: "end", type: "y" },
      ],
    };
    const plug = def.nodes.find((n) => n.id === "plug")!;
    const out = rebuildLinearScenario(def, [plug]);
    const first = pair(out, "start", "plug")!;
    const second = pair(out, "plug", "end")!;
    expect(first).toMatchObject({ id: "e", type: "x" });
    expect(second.type).toBe("y");
    expect(second.id).not.toBe("e");
    expect(new Set(out.edges.map((e) => e.id)).size).toBe(out.edges.length);
  });
});

describe("nodes keep unknown fields through a rebuild", () => {
  it("survives insert, move and remove", () => {
    const base = forkScenario();
    const def: ScenarioDefinition = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "plug"
          ? ({
              ...n,
              futureField: { x: 1 },
              data: { ...n.data, extra: "y" },
            } as unknown as typeof n)
          : n,
      ),
    };
    const check = (out: ScenarioDefinition) => {
      const n = out.nodes.find((x) => x.id === "plug") as unknown as Extra & {
        data: Extra;
      };
      expect(n.futureField).toEqual({ x: 1 });
      expect(n.data.extra).toBe("y");
    };
    const layout = deriveStepLayout(def);
    check(insertLaneStep(def, layout, 0, 1, ScenarioNodeType.DELAY));
    check(moveLaneStep(def, layout, "charge", 1));
    check(removeLaneStep(def, layout, "wait"));
  });
});
