// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { insertForkBlock, recognizeBlockTree } from "../../../lib/blockTree";
import {
  end,
  graph,
  node,
  start,
  sw,
} from "../../../lib/__fixtures__/blockTreeKit";
import { ZOOM_KEY } from "../../../lib/graphZoom";
import StepsGraphView from "./StepsGraphView";

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onWrapInLoopRange = vi.fn();
const onSetLaneExit = vi.fn();

const chain = () =>
  graph(
    [start(), node("a"), node("b"), node("c"), end()],
    [
      ["start", "a"],
      ["a", "b"],
      ["b", "c"],
      ["c", "end"],
    ],
  );

/** a, then a branch (x in one lane), then b. */
const branched = () =>
  graph(
    [start(), node("a"), sw("route"), node("x"), node("b"), end()],
    [
      ["start", "a"],
      ["a", "route"],
      ["route", "x", "case-0"],
      ["route", "b", "default"],
      ["x", "b"],
      ["b", "end"],
    ],
  );

async function render(def: ScenarioDefinition, highlightIds?: string[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsGraphView
        tree={recognizeBlockTree(def)}
        editable
        selectedStepId={null}
        onSelectStep={vi.fn()}
        onInsertStep={onInsertStep}
        onMoveStep={vi.fn()}
        onDeleteStep={vi.fn()}
        onAddLane={vi.fn()}
        onRemoveLane={vi.fn()}
        onUnwrapLoop={vi.fn()}
        onWrapInLoopRange={onWrapInLoopRange}
        onSetLaneExit={onSetLaneExit}
        highlightIds={highlightIds}
      />,
    );
  });
}

async function click(el: Element | null) {
  expect(el, "expected the element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}
const card = (id: string) =>
  container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const cardButton = (id: string) =>
  card(id).querySelector<HTMLButtonElement>("button[data-step-select]")!;
/** The lowest "+" disc: the end of the root lane. */
const rootEnd = () =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[title="Add a step"]'),
  ).sort(
    (x, y) =>
      Number(y.parentElement!.style.top.replace("px", "")) -
      Number(x.parentElement!.style.top.replace("px", "")),
  )[0] ?? null;
const structure = (kind: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[data-step-structure="${kind}"]`,
  );

function hover(el: Element) {
  // React derives pointerenter from pointerover.
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  });
}
function esc() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

describe("StepsGraphView: Repeat picks its target on the canvas", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.clearAllMocks();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  const startPick = async (def: ScenarioDefinition) => {
    await render(def);
    await click(rootEnd());
    await click(structure("loop"));
  };

  it("Repeat at a + shows an arrow and the targets; hovering one outlines the range it would repeat", async () => {
    await startPick(chain());
    expect(container.querySelector("[data-pick-arrow]")).toBeTruthy();
    expect(container.querySelector("[data-pick-panel]")).toBeTruthy();
    expect(container.querySelector("[data-range-highlight]")).toBeNull();
    hover(card("b"));
    expect(
      container.querySelector('[data-range-highlight="pick"]'),
    ).toBeTruthy();
    expect(card("b").dataset.pick).toBe("valid");
    expect(onWrapInLoopRange).not.toHaveBeenCalled();
  });

  it("a click on a valid step makes steps from it to the + a loop", async () => {
    await startPick(chain());
    await click(cardButton("b"));
    // blocks a 0, b 1, c 2: from b to the last.
    expect(onWrapInLoopRange).toHaveBeenCalledWith("root", 1, 2);
    expect(container.querySelector("[data-pick-arrow]")).toBeNull();
  });

  it("a step outside the lane is dimmed with the reason and does nothing", async () => {
    await startPick(branched());
    // x is inside the branch: not a step of the lane the + belongs to.
    expect(card("x").dataset.pick).toBe("invalid");
    expect(card("x").title).toMatch(/same lane/);
    await click(cardButton("x"));
    expect(onWrapInLoopRange).not.toHaveBeenCalled();
    expect(container.querySelector("[data-pick-panel]")?.textContent).toMatch(
      /same lane/,
    );
    expect(container.querySelector("[data-pick-arrow]")).toBeTruthy();
  });

  it("Esc cancels; so does a click on the empty canvas", async () => {
    await startPick(chain());
    esc();
    expect(container.querySelector("[data-pick-arrow]")).toBeNull();
    expect(onWrapInLoopRange).not.toHaveBeenCalled();

    await click(rootEnd());
    await click(structure("loop"));
    expect(container.querySelector("[data-pick-arrow]")).toBeTruthy();
    await click(container.querySelector("[data-picking]"));
    expect(container.querySelector("[data-pick-arrow]")).toBeNull();
    expect(onWrapInLoopRange).not.toHaveBeenCalled();
  });

  it("the keyboard can pick from the list of valid targets", async () => {
    await startPick(chain());
    const target = container.querySelector<HTMLButtonElement>(
      '[data-pick-target="a"]',
    )!;
    expect(target.textContent).toContain("Step 1");
    await click(target);
    expect(onWrapInLoopRange).toHaveBeenCalledWith("root", 0, 2);
  });

  it("the arrow follows the pointer in canvas coordinates, with the zoom and the scroll", async () => {
    window.localStorage.setItem(ZOOM_KEY, "2");
    await startPick(chain());
    const surface = container.querySelector<HTMLElement>("[data-picking]")!;
    // The scaled canvas is at (100, 50) on screen.
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    act(() => {
      surface.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 300,
          clientY: 250,
        }),
      );
    });
    const d = container
      .querySelector('[data-pick-arrow] path[stroke="var(--cx-accent)"]')
      ?.getAttribute("d");
    // (300 - 100) / 2, (250 - 50) / 2.
    expect(d).toMatch(/ 100 100$/);
  });

  it("Repeat is refused (with the reason) where no step is before the +", async () => {
    const def = chain();
    const forked = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    await render(forked);
    // The first lane is empty: nothing before its + to go back to.
    const plus = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[title="Add a step"]',
      ),
    ).find((b) => b.getAttribute("aria-label")?.includes("case"));
    await click(plus ?? null);
    const loop = structure("loop")!;
    expect(loop.disabled).toBe(true);
    expect(loop.title).toMatch(/no earlier step/i);
  });
});

describe("StepsGraphView: a lane's connect arrow", () => {
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("picks the later step a lane continues at", async () => {
    const def = chain();
    const forked = insertForkBlock(
      def,
      recognizeBlockTree(def),
      "root",
      1,
      "switch",
    );
    await render(forked);
    const connect = container.querySelector<HTMLButtonElement>(
      '[data-lane-connect="root/1/lanes/0"]',
    );
    expect(connect?.getAttribute("aria-label")).toBe(
      "Connect lane A to a later step",
    );
    await click(connect);
    expect(container.querySelector("[data-pick-arrow]")).toBeTruthy();
    // b is the merge (the default), c is further down.
    expect(container.querySelector('[data-pick-target="b"]')).toBeTruthy();
    await click(cardButton("c"));
    expect(onSetLaneExit).toHaveBeenCalledWith("root/1/lanes/0", "c");
  });

  it("outlines the steps in range from the inspector", async () => {
    await render(chain(), ["b", "c"]);
    expect(
      container.querySelector('[data-range-highlight="hint"]'),
    ).toBeTruthy();
  });
});
