import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";

import { deriveStepLayout, stepIndexOf, stepPhase } from "./stepLayout";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";

function node(
  id: string,
  type: ScenarioNodeType = ScenarioNodeType.DELAY,
  label = "Delay",
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label } as ScenarioNode["data"],
  };
}

function def(
  nodes: ScenarioNode[],
  pairs: Array<[string, string]>,
): Pick<ScenarioDefinition, "nodes" | "edges"> {
  const edges: Edge[] = pairs.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  }));
  return { nodes, edges };
}

const start = () => node("start", ScenarioNodeType.START, "Start");
const end = () => node("end", ScenarioNodeType.END, "End");
const ids = (nodes: ScenarioNode[]) => nodes.map((n) => n.id);

describe("deriveStepLayout", () => {
  it("a chain is supported and has no fork", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("a"), node("b"), end()],
        [
          ["start", "a"],
          ["a", "b"],
          ["b", "end"],
        ],
      ),
    );
    expect(layout.supported).toBe(true);
    expect(ids(layout.main)).toEqual(["a", "b"]);
    expect(layout.fork).toBeNull();
  });

  it("a chain with a node no walk reaches is unsupported (like deriveLinearSteps)", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("a"), node("orphan"), end()],
        [
          ["start", "a"],
          ["a", "end"],
        ],
      ),
    );
    expect(layout.supported).toBe(false);
  });

  it("splits a fork into its branches, the fork node staying in main", () => {
    const layout = deriveStepLayout(
      def(
        [
          start(),
          node("a"),
          node("fork"),
          node("b1", ScenarioNodeType.METER_VALUE, "Charge to 80%"),
          node("b2"),
          node("c1", ScenarioNodeType.STATUS_TRIGGER, "Wait for Status"),
          end(),
        ],
        [
          ["start", "a"],
          ["a", "fork"],
          ["fork", "b1"],
          ["fork", "c1"],
          ["b1", "b2"],
          ["b2", "end"],
          ["c1", "end"],
        ],
      ),
    );
    expect(layout.supported).toBe(true);
    expect(ids(layout.main)).toEqual(["a", "fork"]);
    expect(layout.fork?.branches.map((b) => b.name)).toEqual([
      // A non-default label names the branch …
      "Charge to 80%",
      // … the type's default label does not.
      "Branch B",
    ]);
    expect(layout.fork?.branches.map((b) => ids(b.steps))).toEqual([
      ["b1", "b2"],
      ["c1"],
    ]);
  });

  it("names a branch by letter when its first label is empty or the registry title", () => {
    const layout = deriveStepLayout(
      def(
        [
          start(),
          node("fork"),
          node("x", ScenarioNodeType.DELAY, ""),
          node("y", ScenarioNodeType.STATUS_CHANGE, "Status Change"),
        ],
        [
          ["start", "fork"],
          ["fork", "x"],
          ["fork", "y"],
        ],
      ),
    );
    expect(layout.fork?.branches.map((b) => b.name)).toEqual([
      "Branch A",
      "Branch B",
    ]);
  });

  it("orders branches by edge order", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("fork"), node("x"), node("y")],
        [
          ["start", "fork"],
          ["fork", "y"],
          ["fork", "x"],
        ],
      ),
    );
    expect(layout.fork?.branches.map((b) => ids(b.steps))).toEqual([
      ["y"],
      ["x"],
    ]);
  });

  it("a fork right after START has an empty main", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("x"), node("y")],
        [
          ["start", "x"],
          ["start", "y"],
        ],
      ),
    );
    expect(layout.supported).toBe(true);
    expect(layout.main).toEqual([]);
    expect(layout.fork?.branches).toHaveLength(2);
  });

  it("a branch ending on a dangling edge is supported", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("fork"), node("x"), node("y"), end()],
        [
          ["start", "fork"],
          ["fork", "x"],
          ["fork", "y"],
          ["x", "missing"],
          ["y", "end"],
        ],
      ),
    );
    expect(layout.supported).toBe(true);
    expect(layout.fork?.branches.map((b) => ids(b.steps))).toEqual([
      ["x"],
      ["y"],
    ]);
  });

  it("a join (two branches reaching one node) is unsupported", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("fork"), node("x"), node("y"), node("join"), end()],
        [
          ["start", "fork"],
          ["fork", "x"],
          ["fork", "y"],
          ["x", "join"],
          ["y", "join"],
          ["join", "end"],
        ],
      ),
    );
    expect(layout.supported).toBe(false);
  });

  it("a loop is unsupported, in main or in a branch", () => {
    expect(
      deriveStepLayout(
        def(
          [start(), node("a"), node("b")],
          [
            ["start", "a"],
            ["a", "b"],
            ["b", "a"],
          ],
        ),
      ).supported,
    ).toBe(false);
    expect(
      deriveStepLayout(
        def(
          [start(), node("fork"), node("x"), node("y")],
          [
            ["start", "fork"],
            ["fork", "x"],
            ["fork", "y"],
            ["y", "fork"],
          ],
        ),
      ).supported,
    ).toBe(false);
  });

  it("a second fork (nested) is unsupported", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("fork"), node("x"), node("y"), node("x1"), node("x2")],
        [
          ["start", "fork"],
          ["fork", "x"],
          ["fork", "y"],
          ["x", "x1"],
          ["x", "x2"],
        ],
      ),
    );
    expect(layout.supported).toBe(false);
  });

  it("an orphan beside a fork is unsupported; an unreached END is not", () => {
    expect(
      deriveStepLayout(
        def(
          [start(), node("fork"), node("x"), node("y"), node("orphan")],
          [
            ["start", "fork"],
            ["fork", "x"],
            ["fork", "y"],
          ],
        ),
      ).supported,
    ).toBe(false);
    expect(
      deriveStepLayout(
        def(
          [start(), node("fork"), node("x"), node("y"), end()],
          [
            ["start", "fork"],
            ["fork", "x"],
            ["fork", "y"],
          ],
        ),
      ).supported,
    ).toBe(true);
  });

  it("no START is unsupported", () => {
    expect(deriveStepLayout(def([node("a")], [])).supported).toBe(false);
  });
});

describe("stepIndexOf", () => {
  it("numbers main first, then each branch in order, 1-based", () => {
    const layout = deriveStepLayout(
      def(
        [start(), node("a"), node("fork"), node("x1"), node("x2"), node("y")],
        [
          ["start", "a"],
          ["a", "fork"],
          ["fork", "x1"],
          ["fork", "y"],
          ["x1", "x2"],
        ],
      ),
    );
    expect(
      ["a", "fork", "x1", "x2", "y"].map((id) => stepIndexOf(layout, id)),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(stepIndexOf(layout, "start")).toBeNull();
  });
});

describe("stepPhase", () => {
  it("todo until executed; current while live; done after", () => {
    expect(stepPhase("a", null, [], "idle")).toBe("todo");
    expect(stepPhase("a", "a", ["a"], "running")).toBe("current");
    expect(stepPhase("a", "a", ["a"], "waiting")).toBe("current");
    expect(stepPhase("a", "b", ["a", "b"], "running")).toBe("done");
    // A run that ended settles its last node as done.
    expect(stepPhase("a", "a", ["a"], "completed")).toBe("done");
  });
});
