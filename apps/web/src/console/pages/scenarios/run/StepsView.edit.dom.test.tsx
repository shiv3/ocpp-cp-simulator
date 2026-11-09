// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ScenarioDefinition,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import statusTriggeredActions from "@ocpp-cp-simulator/core/utils/scenarios/status-triggered-actions.json";
import { findStepLane } from "../../../lib/scenarioSteps";
import { deriveStepLayout } from "../../../lib/stepLayout";
import { forkScenario } from "../../../test/scenarioFixtures";
import StepsView from "./StepsView";

// forkScenario: main [plug 1, status 2], branches [[charge 3, meter 4], [wait 5]].
const forkLayout = deriveStepLayout(forkScenario());
// status-triggered-actions: main [trigger 1, heartbeat 2, delay 3], the
// last two in a loop (delay → heartbeat).
const loopLayout = deriveStepLayout(
  statusTriggeredActions as unknown as ScenarioDefinition,
);
let layout = forkLayout;

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onMoveStep = vi.fn();
const onSelectStep = vi.fn();
const onDeleteStep = vi.fn();

async function render(which = forkLayout) {
  layout = which;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsView
        layout={layout}
        editable
        selectedStepId={null}
        onSelectStep={onSelectStep}
        onInsertStep={onInsertStep}
        onMoveStep={onMoveStep}
        onDeleteStep={onDeleteStep}
        onAddBranch={() => {}}
      />,
    );
  });
}

const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

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

const handleOf = (id: string) =>
  container.querySelector(
    `[data-step-id="${id}"] [aria-label="Drag to reorder"]`,
  )!;

describe("StepsView (editable)", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom lays nothing out: give each box a 52px row in its lane (58px
    // apart, as the boxes and their gaps are on screen).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const id = this.dataset.stepId;
        const top = id ? findStepLane(layout, id)!.index * 58 : 0;
        return {
          top,
          bottom: top + 52,
          height: id ? 52 : 0,
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

  it("inserts between two boxes of the chain through the step picker", async () => {
    await render();
    await click(byLabel("Insert step between 1 and 2"));
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeTruthy();
    await pick("Delay");
    expect(onInsertStep).toHaveBeenCalledWith(
      "main",
      1,
      ScenarioNodeType.DELAY,
    );
    // The picker closes after a pick.
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeNull();
  });

  it("inserts between two boxes of a branch, and never across lanes", async () => {
    await render();
    await click(byLabel("Insert step between 3 and 4"));
    await pick("Meter Value");
    expect(onInsertStep).toHaveBeenCalledWith(
      0,
      1,
      ScenarioNodeType.METER_VALUE,
    );
    // status → charge crosses the fork; meter → wait crosses branches.
    expect(byLabel("Insert step between 2 and 3")).toBeNull();
    expect(byLabel("Insert step between 4 and 5")).toBeNull();
  });

  it("drags a box to a new place within its lane, with a drop indicator", async () => {
    await render();
    expect(
      handleOf("plug").classList.contains("cursor-grab"),
      "the grab handle",
    ).toBe(true);
    pointer("pointerdown", handleOf("charge"), 26);
    pointer("pointermove", handleOf("charge"), 96);
    expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
    pointer("pointerup", handleOf("charge"), 96);
    expect(onMoveStep).toHaveBeenCalledWith("charge", 1);
    expect(container.querySelector("[data-drop-indicator]")).toBeNull();
  });

  it("a drag never leaves its lane", async () => {
    await render();
    // The last chain step dragged far down stays the chain's last step.
    pointer("pointerdown", handleOf("status"), 84);
    pointer("pointermove", handleOf("status"), 600);
    pointer("pointerup", handleOf("status"), 600);
    // Branch B's only step has nowhere to go.
    pointer("pointerdown", handleOf("wait"), 26);
    pointer("pointermove", handleOf("wait"), 300);
    pointer("pointerup", handleOf("wait"), 300);
    expect(onMoveStep).not.toHaveBeenCalled();
    // Up within the chain works.
    pointer("pointerdown", handleOf("status"), 84);
    pointer("pointermove", handleOf("status"), 10);
    pointer("pointerup", handleOf("status"), 10);
    expect(onMoveStep).toHaveBeenCalledWith("status", -1);
  });

  it("Escape cancels a drag", async () => {
    await render();
    pointer("pointerdown", handleOf("plug"), 26);
    pointer("pointermove", handleOf("plug"), 96);
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
    pointer("pointerup", handleOf("plug"), 96);
    expect(onMoveStep).not.toHaveBeenCalled();
  });

  it("Alt+ArrowDown / Alt+ArrowUp on a focused box moves it", async () => {
    await render();
    const plug = byLabel("Select step 1: Connector Plug")!;
    act(() => {
      plug.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onMoveStep).toHaveBeenCalledWith("plug", 1);
    // Without Alt the arrow keys are left alone.
    act(() => {
      plug.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(onMoveStep).toHaveBeenCalledTimes(1);
  });

  describe("inside a loop block", () => {
    const block = () => container.querySelector("[data-loop-block]")!;

    it("inserts inside the block, at its edge outside it, and appends inside it", async () => {
      await render(loopLayout);
      // Between the two looped steps: inside the block.
      const inside = byLabel("Insert step between 2 and 3");
      expect(block().contains(inside)).toBe(true);
      await click(inside);
      expect(
        block().querySelector('input[aria-label="Search step types"]'),
      ).toBeTruthy();
      await pick("Delay");
      expect(onInsertStep).toHaveBeenLastCalledWith(
        "main",
        2,
        ScenarioNodeType.DELAY,
      );
      // Before the loop's first step: above the block, so the new step runs
      // once (the loop still goes back to step 2's node).
      const edge = byLabel("Insert step between 1 and 2");
      expect(edge).toBeTruthy();
      expect(block().contains(edge)).toBe(false);
      await click(edge);
      await pick("Delay");
      expect(onInsertStep).toHaveBeenLastCalledWith(
        "main",
        1,
        ScenarioNodeType.DELAY,
      );
      // "+ Add step" appends to the lane, which the loop closes: inside.
      const add = Array.from(block().querySelectorAll("button")).find(
        (b) => b.textContent === "+ Add step",
      );
      await click(add ?? null);
      await pick("Delay");
      expect(onInsertStep).toHaveBeenLastCalledWith(
        "main",
        3,
        ScenarioNodeType.DELAY,
      );
    });

    it("drags a looped box within the lane, into and out of the block", async () => {
      await render(loopLayout);
      expect(block().contains(handleOf("delay-10s"))).toBe(true);
      // Delay (index 2, centre 142) up past the trigger (centre 26).
      pointer("pointerdown", handleOf("delay-10s"), 142);
      pointer("pointermove", handleOf("delay-10s"), 10);
      expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
      pointer("pointerup", handleOf("delay-10s"), 10);
      expect(onMoveStep).toHaveBeenLastCalledWith("delay-10s", -2);
      // The trigger (outside) down into the block.
      pointer("pointerdown", handleOf("trigger-available"), 26);
      pointer("pointermove", handleOf("trigger-available"), 100);
      pointer("pointerup", handleOf("trigger-available"), 100);
      expect(onMoveStep).toHaveBeenLastCalledWith("trigger-available", 1);
    });

    it("keeps Alt+Arrow on a looped box", async () => {
      await render(loopLayout);
      const delay = byLabel("Select step 3: Delay")!;
      expect(block().contains(delay)).toBe(true);
      act(() => {
        delay.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowUp",
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(onMoveStep).toHaveBeenCalledWith("delay-10s", -1);
    });
  });
});
