import { describe, expect, it } from "vitest";

import {
  createDefaultNode,
  createEmptyScenario,
  deriveLinearSteps,
  insertStep,
  moveStep,
  rebuildLinearScenario,
  removeStep,
  STEP_CATEGORIES,
  stepSummary,
  updateStepData,
} from "./scenarioSteps";
import {
  isScenarioDefinitionShape,
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { Edge } from "@xyflow/react";

// --- fixtures ---------------------------------------------------------

function node(
  id: string,
  type: ScenarioNodeType,
  data: Record<string, unknown>,
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: data as unknown as ScenarioNode["data"],
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

function makeDef(
  nodes: ScenarioNode[],
  edges: Edge[],
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    id: "def-1",
    name: "Test Scenario",
    targetType: "chargePoint",
    nodes,
    edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const startNode = () =>
  node("start", ScenarioNodeType.START, { label: "Start" });
const endNode = () => node("end", ScenarioNodeType.END, { label: "End" });

// --- deriveLinearSteps --------------------------------------------------

describe("deriveLinearSteps", () => {
  it("derives a linear 3-step chain in order", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Available,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 5,
    });
    const c = node("c", ScenarioNodeType.TRANSACTION, {
      label: "C",
      action: "start",
    });
    const def = makeDef(
      [startNode(), a, b, c, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(true);
    expect(result.steps.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(result.startNode?.id).toBe("start");
    expect(result.endNode?.id).toBe("end");
  });

  it("marks a branch (node with >1 outgoing edge) as non-linear", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Available,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 5,
    });
    const c = node("c", ScenarioNodeType.DELAY, {
      label: "C",
      delaySeconds: 5,
    });
    const def = makeDef(
      [startNode(), a, b, c],
      [edge("start", "a"), edge("a", "b"), edge("a", "c")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(false);
  });

  it("marks a missing START node as non-linear", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Available,
    });
    const def = makeDef([a, endNode()], [edge("a", "end")]);

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(false);
    expect(result.startNode).toBeNull();
    expect(result.steps).toEqual([]);
  });

  it("marks a cycle as non-linear without looping forever", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 1,
    });
    const def = makeDef(
      [startNode(), a, b],
      [edge("start", "a"), edge("a", "b"), edge("b", "a")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(false);
  });

  it("marks a disconnected middle (orphan) node as non-linear", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const orphan = node("orphan", ScenarioNodeType.DELAY, {
      label: "Orphan",
      delaySeconds: 1,
    });
    const def = makeDef(
      [startNode(), a, orphan, endNode()],
      [edge("start", "a"), edge("a", "end")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(false);
  });

  it("treats an empty scenario (no nodes) as non-linear", () => {
    const def = makeDef([], []);

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(false);
    expect(result.startNode).toBeNull();
    expect(result.endNode).toBeNull();
    expect(result.steps).toEqual([]);
  });

  it("derives a single-step scenario correctly", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const def = makeDef(
      [startNode(), a, endNode()],
      [edge("start", "a"), edge("a", "end")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(true);
    expect(result.steps.map((n) => n.id)).toEqual(["a"]);
  });

  it("treats a clean chain with no END node as linear, with endNode null", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Available,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 5,
    });
    const def = makeDef(
      [startNode(), a, b],
      [edge("start", "a"), edge("a", "b")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(true);
    expect(result.endNode).toBeNull();
    expect(result.steps.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("returns the END node and excludes it from steps when present (regression)", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Available,
    });
    const def = makeDef(
      [startNode(), a, endNode()],
      [edge("start", "a"), edge("a", "end")],
    );

    const result = deriveLinearSteps(def);

    expect(result.isLinear).toBe(true);
    expect(result.endNode?.id).toBe("end");
    expect(result.steps.map((n) => n.id)).toEqual(["a"]);
  });
});

// --- rebuildLinearScenario ------------------------------------------------

describe("rebuildLinearScenario", () => {
  it("round-trips deriveLinearSteps output: preserves node ids + data, yields chain edges", () => {
    const a = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "A",
      status: OCPPStatus.Charging,
      description: "custom description",
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 42,
    });
    const start = node("start", ScenarioNodeType.START, {
      label: "Start",
      triggerOn: "status",
      targetStatus: OCPPStatus.Available,
    });
    const end = endNode();
    const def = makeDef(
      [start, a, b, end],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );

    const derived = deriveLinearSteps(def);
    expect(derived.isLinear).toBe(true);

    const rebuilt = rebuildLinearScenario(def, derived.steps);

    // node ids + data preserved
    const byId = new Map(rebuilt.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")?.data).toEqual(start.data);
    expect(byId.get("a")?.data).toEqual(a.data);
    expect(byId.get("b")?.data).toEqual(b.data);
    expect(byId.get("end")?.data).toEqual(end.data);

    // chain edges start -> a -> b -> end
    const pairs = rebuilt.edges.map((e) => [e.source, e.target]);
    expect(pairs).toEqual([
      ["start", "a"],
      ["a", "b"],
      ["b", "end"],
    ]);

    // grid layout: x=250, y=idx*120
    expect(byId.get("start")?.position).toEqual({ x: 250, y: 0 });
    expect(byId.get("a")?.position).toEqual({ x: 250, y: 120 });
    expect(byId.get("b")?.position).toEqual({ x: 250, y: 240 });
    expect(byId.get("end")?.position).toEqual({ x: 250, y: 360 });

    // updatedAt bumped
    expect(rebuilt.updatedAt).not.toBe(def.updatedAt);

    // original def not mutated
    expect(def.nodes.find((n) => n.id === "a")?.position).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("creates start/end nodes when absent", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const def = makeDef([a], []);

    const rebuilt = rebuildLinearScenario(def, [a]);

    const types = rebuilt.nodes.map((n) => n.type);
    expect(types).toContain(ScenarioNodeType.START);
    expect(types).toContain(ScenarioNodeType.END);
    expect(rebuilt.nodes).toHaveLength(3);
    expect(rebuilt.edges).toHaveLength(2);
  });

  it("wires start directly to end for zero steps", () => {
    const def = makeDef([startNode(), endNode()], [edge("start", "end")]);

    const rebuilt = rebuildLinearScenario(def, []);

    expect(rebuilt.nodes).toHaveLength(2);
    expect(rebuilt.edges).toEqual([
      { id: expect.any(String), source: "start", target: "end" },
    ]);
  });
});

// --- insertStep / removeStep / moveStep / updateStepData ------------------

/** START forks into two branches — non-linear per `deriveLinearSteps`. */
function branchedDef(): ScenarioDefinition {
  const a = node("a", ScenarioNodeType.DELAY, {
    label: "A",
    delaySeconds: 1,
  });
  const b = node("b", ScenarioNodeType.DELAY, {
    label: "B",
    delaySeconds: 2,
  });
  const c = node("c", ScenarioNodeType.DELAY, {
    label: "C",
    delaySeconds: 3,
  });
  return makeDef(
    [startNode(), a, b, c],
    [edge("start", "a"), edge("a", "b"), edge("a", "c")],
  );
}

describe("insertStep", () => {
  function twoStepDef() {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 2,
    });
    return makeDef(
      [startNode(), a, b, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );
  }

  it("returns a non-linear def unchanged instead of rebuilding from a partial walk", () => {
    const def = branchedDef();
    const result = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
    expect(result).toBe(def);
  });

  it("inserts a new step at index 0 (front)", () => {
    const def = twoStepDef();
    const result = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
    const steps = deriveLinearSteps(result).steps;
    expect(steps.map((n) => n.type)).toEqual([
      ScenarioNodeType.STATUS_CHANGE,
      ScenarioNodeType.DELAY,
      ScenarioNodeType.DELAY,
    ]);
    expect(steps.map((n) => n.id)).toEqual([steps[0].id, "a", "b"]);
  });

  it("inserts a new step in the middle", () => {
    const def = twoStepDef();
    const result = insertStep(def, 1, ScenarioNodeType.STATUS_CHANGE);
    const steps = deriveLinearSteps(result).steps;
    expect(steps.map((n) => n.id)).toEqual(["a", steps[1].id, "b"]);
    expect(steps[1].type).toBe(ScenarioNodeType.STATUS_CHANGE);
  });

  it("inserts a new step at the end", () => {
    const def = twoStepDef();
    const result = insertStep(def, 2, ScenarioNodeType.STATUS_CHANGE);
    const steps = deriveLinearSteps(result).steps;
    expect(steps.map((n) => n.id)).toEqual(["a", "b", steps[2].id]);
    expect(steps[2].type).toBe(ScenarioNodeType.STATUS_CHANGE);
  });
});

describe("removeStep", () => {
  it("returns a non-linear def unchanged instead of rebuilding from a partial walk", () => {
    const def = branchedDef();
    const result = removeStep(def, "b");
    expect(result).toBe(def);
  });

  it("removes a step and re-links its neighbors", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 2,
    });
    const c = node("c", ScenarioNodeType.DELAY, {
      label: "C",
      delaySeconds: 3,
    });
    const def = makeDef(
      [startNode(), a, b, c, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
    );

    const result = removeStep(def, "b");
    const derived = deriveLinearSteps(result);

    expect(derived.isLinear).toBe(true);
    expect(derived.steps.map((n) => n.id)).toEqual(["a", "c"]);
    expect(result.nodes.find((n) => n.id === "b")).toBeUndefined();
    // neighbors re-linked directly
    const pairs = result.edges.map((e) => [e.source, e.target]);
    expect(pairs).toContainEqual(["a", "c"]);
  });
});

describe("moveStep", () => {
  it("returns a non-linear def unchanged instead of rebuilding from a partial walk", () => {
    const def = branchedDef();
    const result = moveStep(def, 0, 1);
    expect(result).toBe(def);
  });

  it("reorders steps: move first to last", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 2,
    });
    const c = node("c", ScenarioNodeType.DELAY, {
      label: "C",
      delaySeconds: 3,
    });
    const def = makeDef(
      [startNode(), a, b, c, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
    );

    const result = moveStep(def, 0, 2);
    const derived = deriveLinearSteps(result);

    expect(derived.steps.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("reorders steps: move last to first", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 2,
    });
    const c = node("c", ScenarioNodeType.DELAY, {
      label: "C",
      delaySeconds: 3,
    });
    const def = makeDef(
      [startNode(), a, b, c, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
    );

    const result = moveStep(def, 2, 0);
    const derived = deriveLinearSteps(result);

    expect(derived.steps.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });
});

describe("updateStepData", () => {
  it("replaces only the target node's data", () => {
    const a = node("a", ScenarioNodeType.DELAY, {
      label: "A",
      delaySeconds: 1,
    });
    const b = node("b", ScenarioNodeType.DELAY, {
      label: "B",
      delaySeconds: 2,
    });
    const def = makeDef(
      [startNode(), a, b, endNode()],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );

    const newData = { label: "A renamed", delaySeconds: 99 };
    const result = updateStepData(def, "a", newData);

    const updatedA = result.nodes.find((n) => n.id === "a");
    const untouchedB = result.nodes.find((n) => n.id === "b");
    expect(updatedA?.data).toEqual(newData);
    expect(untouchedB?.data).toEqual(b.data);
    // positions/edges untouched by a data-only update
    expect(result.edges).toEqual(def.edges);
    expect(updatedA?.position).toEqual(a.position);
  });
});

// --- createDefaultNode ----------------------------------------------------

describe("createDefaultNode", () => {
  it("generates unique ids across successive calls (no Date.now()-style collisions)", () => {
    const n1 = createDefaultNode(ScenarioNodeType.DELAY);
    const n2 = createDefaultNode(ScenarioNodeType.DELAY);
    expect(n1.id).not.toBe(n2.id);
  });

  it("produces valid default node data for every non-START/END ScenarioNodeType", () => {
    for (const type of Object.values(ScenarioNodeType)) {
      if (type === ScenarioNodeType.START || type === ScenarioNodeType.END)
        continue;
      const n = createDefaultNode(type);
      expect(n.type).toBe(type);
      expect(typeof n.data.label).toBe("string");
      expect(n.data.label.length).toBeGreaterThan(0);
    }
  });

  it("creates START and END nodes too", () => {
    const start = createDefaultNode(ScenarioNodeType.START);
    const end = createDefaultNode(ScenarioNodeType.END);
    expect(start.type).toBe(ScenarioNodeType.START);
    expect(end.type).toBe(ScenarioNodeType.END);
  });
});

// --- createEmptyScenario ----------------------------------------------------

describe("createEmptyScenario", () => {
  it("passes isScenarioDefinitionShape and wires START->END", () => {
    const scenario = createEmptyScenario("My Scenario", "chargePoint");

    expect(isScenarioDefinitionShape(scenario)).toBe(true);
    expect(scenario.name).toBe("My Scenario");
    expect(scenario.targetType).toBe("chargePoint");
    expect(scenario.trigger).toEqual({ type: "manual" });
    expect(scenario.enabled).toBe(true);
    expect(typeof scenario.createdAt).toBe("string");
    expect(typeof scenario.updatedAt).toBe("string");

    const derived = deriveLinearSteps(scenario);
    expect(derived.isLinear).toBe(true);
    expect(derived.steps).toEqual([]);
    expect(derived.startNode).not.toBeNull();
    expect(derived.endNode).not.toBeNull();
  });

  it("supports connector targeting with a targetId", () => {
    const scenario = createEmptyScenario("Connector Scenario", "connector", 3);
    expect(scenario.targetType).toBe("connector");
    expect(scenario.targetId).toBe(3);
  });
});

// --- stepSummary ----------------------------------------------------

describe("stepSummary", () => {
  it("summarizes STATUS_CHANGE as an arrow to the target status", () => {
    const n = node("a", ScenarioNodeType.STATUS_CHANGE, {
      label: "Status Change",
      status: OCPPStatus.Charging,
    });
    expect(stepSummary(n)).toBe("→ Charging");
  });

  it("summarizes DELAY in seconds", () => {
    const n = node("a", ScenarioNodeType.DELAY, {
      label: "Delay",
      delaySeconds: 7,
    });
    expect(stepSummary(n)).toBe("7 s");
  });

  it("summarizes TRANSACTION with action and optional tag", () => {
    const withTag = node("a", ScenarioNodeType.TRANSACTION, {
      label: "Transaction",
      action: "start",
      tagId: "abc123",
    });
    expect(stepSummary(withTag)).toBe("start · tag abc123");

    const withoutTag = node("b", ScenarioNodeType.TRANSACTION, {
      label: "Transaction",
      action: "stop",
    });
    expect(stepSummary(withoutTag)).toBe("stop");
  });

  it("summarizes CSMS_CALL_TRIGGER as a wait with optional timeout", () => {
    const withTimeout = node("a", ScenarioNodeType.CSMS_CALL_TRIGGER, {
      label: "Wait for CSMS Call",
      action: "Reset",
      timeout: 30,
    });
    expect(stepSummary(withTimeout)).toBe("wait Reset · 30s");

    const withoutTimeout = node("b", ScenarioNodeType.CSMS_CALL_TRIGGER, {
      label: "Wait for CSMS Call",
      action: "Reset",
      timeout: 0,
    });
    expect(stepSummary(withoutTimeout)).toBe("wait Reset");
  });

  it("falls back to the node label for unmodeled node types", () => {
    const n = node("a", ScenarioNodeType.START, { label: "My Start Label" });
    expect(stepSummary(n)).toBe("My Start Label");
  });
});

// --- STEP_CATEGORIES ----------------------------------------------------

describe("STEP_CATEGORIES", () => {
  it("includes every ScenarioNodeType except START/END exactly once", () => {
    const allTypes = Object.values(ScenarioNodeType).filter(
      (t) => t !== ScenarioNodeType.START && t !== ScenarioNodeType.END,
    );
    const counts = new Map<string, number>();
    for (const category of STEP_CATEGORIES) {
      for (const type of category.types) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }

    for (const type of allTypes) {
      expect(counts.get(type)).toBe(1);
    }
    // no extras (e.g. START/END, or duplicates inflating the total)
    const totalListed = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(totalListed).toBe(allTypes.length);
    expect(counts.has(ScenarioNodeType.START)).toBe(false);
    expect(counts.has(ScenarioNodeType.END)).toBe(false);
  });
});
