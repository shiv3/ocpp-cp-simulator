// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { recognizeBlockTree } from "../../../lib/blockTree";
import {
  deadLanes,
  ifElseReconverges,
  startFanOutWithLoop,
  switchInLane,
  withDetached,
} from "../../../test/treeFixtures";
import StepsView from "./StepsView";

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onMoveStep = vi.fn();
const onSelectStep = vi.fn();
const onDeleteStep = vi.fn();
const onAddLane = vi.fn();
const onRemoveLane = vi.fn();
const onUnwrapLoop = vi.fn();

async function render(def: ScenarioDefinition) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsView
        tree={recognizeBlockTree(def)}
        editable
        selectedStepId={null}
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

const handleOf = (id: string) =>
  container.querySelector(
    `[data-step-id="${id}"] [aria-label="Drag to reorder"]`,
  )!;

describe("StepsView (editable block tree)", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom lays nothing out: give each block a 52px row in its sequence
    // (58px apart, as the boxes and their gaps are on screen).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const block = this.dataset.block;
        const top = block !== undefined ? Number(block) * 58 : 0;
        return {
          top,
          bottom: top + 52,
          height: block !== undefined ? 52 : 0,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("inserts at depth: between two blocks of a lane, at a lane's top, at a nested lane's end", async () => {
    await render(switchInLane());
    // route 1, a 2, inner 3, x 4, y 5, b 6.
    await click(byLabel("Insert step between 2 and 3"));
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeTruthy();
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0",
      1,
      ScenarioNodeType.DELAY,
    );
    // The picker closes after a pick.
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeNull();

    await click(byLabel("Insert step before step 2"));
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0",
      0,
      ScenarioNodeType.DELAY,
    );

    await click(byLabel('Add step to case-0 → "Charging"'));
    await pick("Meter Value");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0/1/lanes/0",
      1,
      ScenarioNodeType.METER_VALUE,
    );
  });

  it("offers no insert where nothing runs; '+ Add step' under a block that ends every path is left out", async () => {
    await render(switchInLane());
    // The root ends with route's lanes: nothing could follow them.
    const rootList = container.querySelector('[data-lane-list="root"]')!;
    const rootAdd = Array.from(rootList.parentElement!.children).filter(
      (el) => el.textContent === "+ Add step",
    );
    expect(rootAdd).toHaveLength(0);
  });

  it("a loop body's slots are its own: insert inside the block", async () => {
    await render(startFanOutWithLoop());
    const block = container.querySelector("[data-loop-block]")!;
    // l0a 1, l0b 2.
    const inside = byLabel("Insert step between 1 and 2");
    expect(block.contains(inside)).toBe(true);
    await click(inside);
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "root/0/lanes/0/0/body",
      1,
      ScenarioNodeType.DELAY,
    );
  });

  it("a jump back into START says so in words, not a number", async () => {
    const start = recognizeBlockTree(startFanOutWithLoop()).origin!;
    await render({
      ...startFanOutWithLoop(),
      edges: [
        ...startFanOutWithLoop().edges.filter((e) => e.source !== "c1"),
        { id: "c1->start", source: "c1", target: start.id },
      ],
    });
    const note = container.querySelector('[data-link-to="start"]');
    expect(note?.textContent).toBe("Then back to START");
  });

  it("'Stop repeating' on the loop's top arm unwraps that loop", async () => {
    await render(startFanOutWithLoop());
    const block = container.querySelector("[data-loop-block]")!;
    const button = block.querySelector<HTMLButtonElement>(
      '[data-testid="unwrap-loop"]',
    )!;
    expect(button.textContent).toContain("Stop repeating");
    expect(button.disabled).toBe(false);
    await click(button);
    expect(onUnwrapLoop).toHaveBeenCalledWith("l0a");
  });

  it("drags a box within its sequence, with a drop indicator; nested too", async () => {
    await render(withDetached());
    pointer("pointerdown", handleOf("s1"), 26);
    pointer("pointermove", handleOf("s1"), 96);
    expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
    pointer("pointerup", handleOf("s1"), 96);
    expect(onMoveStep).toHaveBeenLastCalledWith("s1", 1);
    expect(container.querySelector("[data-drop-indicator]")).toBeNull();

    await act(async () => root?.unmount());
    await render(startFanOutWithLoop());
    // l0b (block 1 of the loop body) up past l0a.
    pointer("pointerdown", handleOf("l0b"), 84);
    pointer("pointermove", handleOf("l0b"), 10);
    pointer("pointerup", handleOf("l0b"), 10);
    expect(onMoveStep).toHaveBeenLastCalledWith("l0b", -1);
  });

  it("a drag never leaves its sequence, and a branch point has no grab handle", async () => {
    await render(ifElseReconverges());
    // ok is the only step of its lane: nowhere to go.
    pointer("pointerdown", handleOf("ok"), 26);
    pointer("pointermove", handleOf("ok"), 400);
    pointer("pointerup", handleOf("ok"), 400);
    expect(onMoveStep).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-step-id="check"] [aria-label="Drag to reorder"]',
      ),
    ).toBeNull();
  });

  it("Escape cancels a drag", async () => {
    await render(withDetached());
    pointer("pointerdown", handleOf("s1"), 26);
    pointer("pointermove", handleOf("s1"), 96);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.querySelector("[data-drop-indicator]")).toBeNull();
    pointer("pointerup", handleOf("s1"), 96);
    expect(onMoveStep).not.toHaveBeenCalled();
  });

  it("Alt+Arrow and Delete on a focused box at depth", async () => {
    await render(switchInLane());
    const x = byLabel("Select step 4: Delay")!;
    key(x, { key: "ArrowUp", altKey: true });
    expect(onMoveStep).toHaveBeenCalledWith("x", -1);
    // Without Alt the arrow keys are left alone.
    key(x, { key: "ArrowDown" });
    expect(onMoveStep).toHaveBeenCalledTimes(1);
    key(x, { key: "Delete" });
    expect(onDeleteStep).toHaveBeenCalledWith("x", { confirm: true });
    // A branch point's box takes the keys too.
    key(byLabel("Select step 3: Switch")!, { key: "Delete" });
    expect(onDeleteStep).toHaveBeenLastCalledWith("inner", { confirm: true });
  });

  it("'+ branch' and remove-branch are enabled from the capabilities, with the reason when refused", async () => {
    await render(ifElseReconverges());
    // check's only case and its default both have a lane.
    const add = byLabel("Add a branch to step 2")!;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe(
      "Every case or option already has a branch; a new branch would never run.",
    );
    const remove = byLabel("Remove branch B")!;
    expect(remove.disabled).toBe(false);
    await click(remove);
    expect(onRemoveLane).toHaveBeenCalledWith("check", 1);

    await act(async () => root?.unmount());
    await render(deadLanes());
    // route ["a"]: case-0 and default taken, so no free handle either; the
    // running case-0 lane has an ignored twin: removing it would revive it.
    const running = byLabel("Remove branch A")!;
    expect(running.disabled).toBe(true);
    expect(running.title).toBe(
      "Another edge that never runs today would start running in its place; remove that branch first.",
    );
  });

  it("adds a branch to START: in the fork header, or under a chain", async () => {
    await render(startFanOutWithLoop());
    const add = byLabel("Add a parallel branch")!;
    expect(add.disabled).toBe(false);
    await click(add);
    expect(onAddLane).toHaveBeenCalledWith("start");

    await act(async () => root?.unmount());
    await render(withDetached());
    await click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "+ Add parallel branch",
      ) ?? null,
    );
    expect(onAddLane).toHaveBeenLastCalledWith("start");
  });

  it("a switch with a free case adds a branch", async () => {
    const def = ifElseReconverges();
    def.nodes = def.nodes.map((n) =>
      n.id === "check"
        ? { ...n, data: { ...n.data, cases: ["Accepted", "Rejected"] } }
        : n,
    ) as typeof def.nodes;
    await render(def);
    const add = byLabel("Add a branch to step 2")!;
    expect(add.disabled).toBe(false);
    await click(add);
    expect(onAddLane).toHaveBeenCalledWith("check");
  });
});
