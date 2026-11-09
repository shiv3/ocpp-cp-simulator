// @vitest-environment jsdom
/**
 * A Repeat block's bounds (schema 1.10 loop edges) in the Steps and Graph
 * views: the header's summary, and the inline editor writing the loop edge.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Edge } from "@xyflow/react";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  canSetLoopBounds,
  recognizeBlockTree,
  setLoopBounds,
} from "../../../lib/blockTree";
import {
  end,
  graph,
  node,
  start,
} from "../../../lib/__fixtures__/blockTreeKit";
import StepsGraphView from "./StepsGraphView";
import StepsView from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;
let latest: ScenarioDefinition;

/** START → a → m → b → END; m repeats itself 2 times. */
const selfLoop = (loop: unknown = { times: 2 }): ScenarioDefinition => {
  const def = graph(
    [start(), node("a"), node("m"), node("b"), end()],
    [
      ["start", "a"],
      ["a", "m"],
      ["m", "b"],
      ["b", "end"],
    ],
  );
  return {
    ...def,
    edges: [
      ...def.edges,
      { id: "loop", source: "m", target: "m", kind: "loop", loop } as Edge,
    ],
  };
};

/** Holds the scenario, as the editor page does, and applies bound edits. */
function Harness({
  initial,
  graphView,
}: {
  initial: ScenarioDefinition;
  graphView: boolean;
}) {
  const [def, setDef] = useState(initial);
  latest = def;
  const tree = recognizeBlockTree(def);
  const loopBounds = {
    canSet: (headerId: string, bounds: object) =>
      canSetLoopBounds(tree, headerId, bounds),
    onSet: (headerId: string, bounds: object) =>
      setDef(setLoopBounds(def, tree, headerId, bounds)),
  };
  const common = {
    tree,
    editable: true,
    selectedStepId: null,
    onSelectStep: vi.fn(),
    onInsertStep: vi.fn(),
    onMoveStep: vi.fn(),
    onDeleteStep: vi.fn(),
    onAddLane: vi.fn(),
    onRemoveLane: vi.fn(),
    onUnwrapLoop: vi.fn(),
    loopBounds,
  };
  return graphView ? <StepsGraphView {...common} /> : <StepsView {...common} />;
}

async function render(def: ScenarioDefinition, graphView = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness initial={def} graphView={graphView} />);
  });
}

async function click(el: Element | null) {
  expect(el, "expected the element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(el: Element | null, value: string) {
  expect(el, "expected the input").toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const q = (sel: string) => container.querySelector<HTMLInputElement>(sel);
const summary = () => q('[data-testid="loop-summary"]')?.textContent ?? "";
const loopEdge = () =>
  latest.edges.find((e) => e.id === "loop") as Edge & { loop?: unknown };

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Steps view: a Repeat block's bounds", () => {
  it("the header says the bounds; the editor writes them into the loop edge", async () => {
    await render(selfLoop());
    expect(summary()).toBe("Repeat 2 times");
    await click(q('[data-testid="edit-loop-bounds"]'));
    expect(q('[data-testid="loop-bounds-panel"]')).toBeTruthy();

    await type(q('[data-testid="loop-times"]'), "5");
    expect(loopEdge()).toMatchObject({ kind: "loop", loop: { times: 5 } });
    expect(summary()).toBe("Repeat 5 times");

    // A duration too: hours / minutes / seconds → forSeconds.
    await click(q('[data-testid="loop-bound-forSeconds"]'));
    await type(q('[data-testid="loop-hours"]'), "2");
    await type(q('[data-testid="loop-minutes"]'), "0");
    await type(q('[data-testid="loop-seconds"]'), "0");
    expect(loopEdge().loop).toEqual({ times: 5, forSeconds: 7200 });
    expect(summary()).toBe("Repeat 5 times / for 2 h (whichever first)");
  });

  it("until is built like a switch: value, cases (a $match one as a chip)", async () => {
    await render(
      selfLoop({
        until: {
          value: { $from: "connector.power.soc" },
          cases: [{ $match: { gte: 80 } }],
        },
      }),
    );
    expect(summary()).toBe("Repeat until $from: connector.power.soc is ≥ 80");
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="loop-until-chip"]'),
      ).map((c) => c.textContent),
    ).toEqual(["≥ 80"]);
    await click(q('[data-testid="edit-loop-bounds"]'));
    // The switch's case list: the $match case is shown, not edited.
    expect(q('[data-testid="loop-until-case-match-0"]')).toBeTruthy();
    await click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Add case",
      ) ?? null,
    );
    expect(loopEdge().loop).toEqual({
      until: {
        value: { $from: "connector.power.soc" },
        cases: [{ $match: { gte: 80 } }, ""],
      },
    });
  });

  it("the last bound of a loop with steps after it cannot go, and says why", async () => {
    await render(selfLoop());
    await click(q('[data-testid="edit-loop-bounds"]'));
    const times = q('[data-testid="loop-bound-times"]')!;
    expect(times.checked).toBe(true);
    expect(times.disabled).toBe(true);
    expect(q('[data-testid="loop-bound-times-refusal"]')?.textContent).toMatch(
      /keep at least one bound/,
    );
    expect(loopEdge().loop).toEqual({ times: 2 });
  });

  it("a plain loop says Repeat forever; bounds turn its back edge into a loop edge", async () => {
    const def = graph(
      [start(), node("a"), node("b"), end()],
      [
        ["start", "a"],
        ["a", "b"],
        ["b", "a"],
      ],
    );
    await render(def);
    expect(container.querySelector("[data-loop-block]")?.textContent).toContain(
      "Repeat forever",
    );
    await click(q('[data-testid="edit-loop-bounds"]'));
    await click(q('[data-testid="loop-bound-times"]'));
    expect(latest.edges.find((e) => e.id === "b->a")).toMatchObject({
      kind: "loop",
      loop: { times: 3 },
    });
    expect(summary()).toBe("Repeat 3 times");
  });
});

describe("Graph view: a loop frame's bounds", () => {
  it("the frame's label says the bounds; Bounds opens the same editor", async () => {
    await render(selfLoop({ times: 2, forSeconds: 90 }), true);
    expect(summary()).toBe("Repeat 2 times / for 1 min 30 s (whichever first)");
    await click(q('[data-testid="edit-loop-bounds"][data-loop="m"]'));
    expect(q('[data-testid="loop-bounds-panel"]')).toBeTruthy();
    await click(q('[data-testid="loop-bound-times"]'));
    expect(loopEdge().loop).toEqual({ forSeconds: 90 });
    expect(summary()).toBe("Repeat for 1 min 30 s");
    await click(q('[data-testid="loop-bounds-done"]'));
    expect(q('[data-testid="loop-bounds-panel"]')).toBeNull();
  });
});

describe("Graph view: the loop frame's label row", () => {
  it("keeps the summary on its own row, apart from the buttons, with the full text on hover", async () => {
    await render(selfLoop(), true);
    const label = q('[data-testid="loop-summary"]')!;
    expect(label.textContent).toBe("Repeat 2 times");
    expect(label.getAttribute("title")).toBe("Repeat 2 times");
    const button = q('[data-testid="edit-loop-bounds"]')!;
    const row = (el: Element) => (el.closest(".absolute") as HTMLElement).style;
    expect(row(button).top).not.toBe(row(label).top);
    expect(row(button).left).toBe(row(label).left);
  });
});
