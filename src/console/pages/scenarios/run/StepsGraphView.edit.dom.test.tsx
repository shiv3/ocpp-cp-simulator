// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ScenarioNodeType } from "../../../../cp/application/scenario/ScenarioTypes";
import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import { deriveStepLayout, type StepLayout } from "../../../lib/stepLayout";
import { forkScenario } from "../../../test/scenarioFixtures";
import StepsGraphView from "./StepsGraphView";

// forkScenario: main [plug 1, status 2], branches [[charge 3, meter 4], [wait 5]].
const forkLayout = deriveStepLayout(forkScenario());

let root: Root | null = null;
let container: HTMLElement;
const onInsertStep = vi.fn();
const onMoveStep = vi.fn();
const onSelectStep = vi.fn();
const onDeleteStep = vi.fn();
const onAddBranch = vi.fn();

async function render(
  layout: StepLayout = forkLayout,
  selectedStepId: string | null = null,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StepsGraphView
        layout={layout}
        editable
        selectedStepId={selectedStepId}
        onSelectStep={onSelectStep}
        onInsertStep={onInsertStep}
        onMoveStep={onMoveStep}
        onDeleteStep={onDeleteStep}
        onAddBranch={onAddBranch}
      />,
    );
  });
}

const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
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

describe("StepsGraphView (editable)", () => {
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

  it("keeps the run view's cards and paths, and a click selects a card", async () => {
    await render();
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(5);
    expect(
      container.querySelectorAll("svg[data-graph-edges] path"),
    ).toHaveLength(7);
    await click(cardButton("charge"));
    expect(onSelectStep).toHaveBeenCalledWith("charge");
  });

  it("a + after the last card of the chain and of each branch adds a step there", async () => {
    await render();
    await click(byLabel("Add step after step 4"));
    expect(
      container.querySelector('input[aria-label="Search step types"]'),
    ).toBeTruthy();
    await pick("Delay");
    expect(onInsertStep).toHaveBeenCalledWith(0, 2, ScenarioNodeType.DELAY);

    await click(byLabel("Add step after step 5"));
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(1, 1, ScenarioNodeType.DELAY);

    // The chain's own: the new step becomes the fork node.
    await click(byLabel("Add step after step 2"));
    await pick("Delay");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "main",
      2,
      ScenarioNodeType.DELAY,
    );
  });

  it("a + between two cards of a lane inserts there", async () => {
    await render();
    await click(byLabel("Insert step between 3 and 4"));
    await pick("Meter Value");
    expect(onInsertStep).toHaveBeenCalledWith(
      0,
      1,
      ScenarioNodeType.METER_VALUE,
    );
    await click(byLabel("Insert step between 1 and 2"));
    await pick("Meter Value");
    expect(onInsertStep).toHaveBeenLastCalledWith(
      "main",
      1,
      ScenarioNodeType.METER_VALUE,
    );
    // Across the fork or between branches is not "between".
    expect(byLabel("Insert step between 2 and 3")).toBeNull();
    expect(byLabel("Insert step between 4 and 5")).toBeNull();
  });

  it("+ branch sits by the fork, or by the last card of a chain", async () => {
    await render();
    await click(byLabel("Add a parallel branch"));
    expect(onAddBranch).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());

    let chain = createEmptyScenario("Chain", "connector", 1);
    chain = insertStep(chain, 0, ScenarioNodeType.DELAY);
    chain = insertStep(chain, 1, ScenarioNodeType.DELAY);
    await render(deriveStepLayout(chain));
    const pill = byLabel("Add a parallel branch")!;
    const last = deriveStepLayout(chain).main[1];
    // Level with the last card.
    expect(
      parseFloat(pill.style.top) - parseFloat(card(last.id).style.top),
    ).toBeGreaterThan(0);
    expect(
      parseFloat(pill.style.top) - parseFloat(card(last.id).style.top),
    ).toBeLessThan(52);
  });

  it("drags a card within its lane: it follows the pointer over a drop line, and the release moves it", async () => {
    await render();
    pointer("pointerdown", cardButton("charge"), 300);
    pointer("pointermove", cardButton("charge"), 380);
    expect(card("charge").style.transform).toBe("translateY(80px)");
    expect(container.querySelector("[data-drop-indicator]")).toBeTruthy();
    pointer("pointerup", cardButton("charge"), 380);
    expect(onMoveStep).toHaveBeenCalledWith("charge", 1);

    // Branch B's only card cannot move into branch A.
    pointer("pointerdown", cardButton("wait"), 300);
    pointer("pointermove", cardButton("wait"), 500);
    pointer("pointerup", cardButton("wait"), 500);
    expect(onMoveStep).toHaveBeenCalledTimes(1);
  });

  it("the selected card has a ✕ that deletes it", async () => {
    await render(forkLayout, "meter");
    expect(byLabel("Remove step 3")).toBeNull();
    await click(byLabel("Remove step 4"));
    expect(onDeleteStep).toHaveBeenCalledWith("meter", { confirm: false });
  });

  it("Alt+ArrowUp / Alt+ArrowDown move a card, Delete asks to remove it", async () => {
    await render(forkLayout, "meter");
    key(cardButton("meter"), { key: "ArrowUp", altKey: true });
    expect(onMoveStep).toHaveBeenCalledWith("meter", -1);
    key(cardButton("plug"), { key: "ArrowDown", altKey: true });
    expect(onMoveStep).toHaveBeenLastCalledWith("plug", 1);
    key(cardButton("meter"), { key: "Delete" });
    expect(onDeleteStep).toHaveBeenCalledWith("meter", { confirm: true });
  });
});
