// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import { GAP, layoutTreeGraph } from "../../../lib/treeGraphLayout";
import {
  ifElseReconverges,
  loopWithTwoExits,
  startFanOutWithLoop,
  switchInLane,
  withDetached,
} from "../../../test/treeFixtures";
import StepsGraphView from "./StepsGraphView";

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onMoveStep = vi.fn();
const onSelectStep = vi.fn();
const onDeleteStep = vi.fn();
const onAddLane = vi.fn();
const onRemoveLane = vi.fn();
const onUnwrapLoop = vi.fn();

async function render(
  def: ScenarioDefinition,
  selectedStepId: string | null = null,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsGraphView
        tree={recognizeBlockTree(def)}
        editable
        selectedStepId={selectedStepId}
        onSelectStep={onSelectStep}
        onInsertStep={onInsertStep}
        onMoveStep={onMoveStep}
        onDeleteStep={onDeleteStep}
        onAddLane={onAddLane}
        onRemoveLane={onRemoveLane}
        onUnwrapLoop={onUnwrapLoop}
      />,
    );
  });
}

const byLabel = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  ) ?? null;
const card = (id: string) =>
  container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const cardButton = (id: string) =>
  card(id).querySelector<HTMLButtonElement>(
    'button[aria-label^="Select step"]',
  )!;

async function click(el: Element | null) {
  expect(el, "expected the element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function pick(title: string) {
  await click(
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === title,
    ) ?? null,
  );
}

function pointer(type: string, el: Element, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientY,
      }),
    );
  });
}

function key(el: Element, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

describe("StepsGraphView (editable block tree)", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("a click selects a card at any depth; the selected card's ✕ deletes it", async () => {
    await render(switchInLane());
    await click(cardButton("x"));
    expect(onSelectStep).toHaveBeenCalledWith("x");
    await act(async () => root?.unmount());
    await render(switchInLane(), "x");
    await click(byLabel("Remove step 4"));
    expect(onDeleteStep).toHaveBeenCalledWith("x", { confirm: false });
  });

  it("inserts at depth: a disc at a nested lane's end, a zone between two blocks of a lane", async () => {
    await render(switchInLane());
    // route 1, a 2, inner 3, x 4, y 5, b 6.
    await click(byLabel("Add step after step 4"));
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeTruthy();
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0/1/lanes/0",
      1,
      ScenarioNodeType.DELAY,
    );
    await click(byLabel("Insert step between 2 and 3"));
    await pick("Meter Value");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0",
      1,
      ScenarioNodeType.METER_VALUE,
    );
    // Nothing can follow route's lanes: no disc after the root.
    expect(
      Array.from(container.querySelectorAll("button")).filter((b) =>
        b.getAttribute("aria-label")?.startsWith("Add step after the block"),
      ),
    ).toHaveLength(0);
  });

  it("+ branch by a branch point is enabled from the capabilities, with the reason when refused", async () => {
    await render(ifElseReconverges());
    const add = byLabel("Add a branch to step 2")!;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe(
      "Every case or option already has a branch; a new branch would never run.",
    );
    await click(byLabel("Remove branch B"));
    expect(onRemoveLane).toHaveBeenCalledWith("check", 1);

    await act(async () => root?.unmount());
    await render(startFanOutWithLoop());
    await click(byLabel("Add a parallel branch"));
    expect(onAddLane).toHaveBeenCalledWith("start");

    await act(async () => root?.unmount());
    // A chain from START: the pill stands by the start dot.
    await render(withDetached());
    await click(byLabel("Add a parallel branch"));
    expect(onAddLane).toHaveBeenLastCalledWith("start");
  });

  it("drags a card within its sequence; a branch point's card does not drag", async () => {
    await render(withDetached());
    // s1 (centre 89) down past s2 (centre 165).
    pointer("pointerdown", card("s1"), 89);
    pointer("pointermove", card("s1"), 180);
    expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
    pointer("pointerup", card("s1"), 180);
    expect(onMoveStep).toHaveBeenCalledWith("s1", 1);

    await act(async () => root?.unmount());
    await render(ifElseReconverges());
    pointer("pointerdown", card("check"), 165);
    pointer("pointermove", card("check"), 400);
    pointer("pointerup", card("check"), 400);
    expect(container.querySelector("[data-drop-indicator]")).toBeNull();
    expect(onMoveStep).toHaveBeenCalledTimes(1);
  });

  it("the drop line counts a loop as a block of its sequence (it has no card there)", async () => {
    const def = loopWithTwoExits();
    // root: first, the loop (head …), out.
    const g = layoutTreeGraph(recognizeBlockTree(def), {
      editable: true,
      phaseOf: () => "todo",
    });
    const [firstCentre, loopCentre] = g.centres.get("root")!;
    const out = g.cards.find((c) => c.node.id === "out")!;
    await render(def);
    // first, dragged down past the loop: it would land between the loop
    // and out.
    pointer("pointerdown", card("first"), firstCentre);
    pointer("pointermove", card("first"), loopCentre + 10);
    const line = container.querySelector<HTMLElement>("[data-drop-indicator]");
    expect(line).toBeTruthy();
    expect(parseFloat(line!.style.top)).toBe(out.y - GAP / 2 - 1);
    pointer("pointerup", card("first"), loopCentre + 10);
    expect(onMoveStep).toHaveBeenCalledWith("first", 1);
  });

  it("'Stop repeating' by the loop's label unwraps that loop", async () => {
    await render(startFanOutWithLoop());
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="unwrap-loop"]',
    )!;
    expect(button.textContent).toContain("Stop repeating");
    // On the row under the loop's label (same left edge); no stray text.
    const label = container.querySelector<HTMLElement>("[data-loop-block]")!;
    const rowOf = (el: Element) =>
      (el.closest(".absolute") as HTMLElement).style;
    expect(rowOf(button).left).toBe(rowOf(label).left);
    expect(container.textContent).not.toContain("//");
    expect(button.disabled).toBe(false);
    await click(button);
    expect(onUnwrapLoop).toHaveBeenCalledWith("l0a");
  });

  it("Alt+Arrow moves a nested card, Delete asks to remove it", async () => {
    await render(switchInLane());
    key(cardButton("y"), { key: "ArrowUp", altKey: true });
    expect(onMoveStep).toHaveBeenCalledWith("y", -1);
    key(cardButton("y"), { key: "Delete" });
    expect(onDeleteStep).toHaveBeenCalledWith("y", { confirm: true });
  });
});
