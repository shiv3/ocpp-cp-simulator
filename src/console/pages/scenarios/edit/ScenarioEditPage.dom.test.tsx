// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createDefaultNode,
  createEmptyScenario,
  insertStep,
} from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type DelayNodeData,
  type ScenarioDefinition,
} from "../../../../cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  renderConsole,
} from "../../../test/harness";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function linearFixture(): ScenarioDefinition {
  let def = createEmptyScenario("Linear demo", "connector", 1);
  def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
  def = insertStep(def, 1, ScenarioNodeType.DELAY);
  return { ...def, id: "s1" };
}

/** START forks into two branches — `deriveLinearSteps` reports
 *  `isLinear: false` the moment a node has >1 outgoing edge. */
function branchFixture(): ScenarioDefinition {
  const base = createEmptyScenario("Branchy", "connector", 1);
  const start = base.nodes.find((n) => n.type === ScenarioNodeType.START)!;
  const end = base.nodes.find((n) => n.type === ScenarioNodeType.END)!;
  const branchA = createDefaultNode(ScenarioNodeType.STATUS_CHANGE);
  const branchB = createDefaultNode(ScenarioNodeType.DELAY);
  return {
    ...base,
    id: "s-branch",
    nodes: [start, branchA, branchB, end],
    edges: [
      { id: "e1", source: start.id, target: branchA.id },
      { id: "e2", source: start.id, target: branchB.id },
    ],
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ScenarioEditPage", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("lists both step titles, edits the Delay step via the inspector, and saves the updated definition", async () => {
    const fixture = linearFixture();
    const saveScenarioDefinition = vi.fn(
      async (
        _cpId: string,
        _connectorId: number | null,
        def: ScenarioDefinition,
      ) => def,
    );
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // Both step titles listed.
    expect(container.textContent).toContain("Status Change");
    expect(container.textContent).toContain("Delay");

    // a11y: the step row container is no longer role="button" (interactive
    // controls — the selection button, move/delete buttons — are its
    // children instead of the row itself being interactive).
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);

    const selectButtons = Array.from(
      container.querySelectorAll('button[aria-label^="Select step"]'),
    ) as HTMLElement[];
    const delayButton = selectButtons.find((b) =>
      b.textContent?.includes("Delay"),
    );
    expect(delayButton, "expected a Delay step selection button").toBeTruthy();

    // Click step 2 (Delay) -> inspector shows the Delay form's number input.
    await act(async () => {
      delayButton!.click();
    });

    const numberInput = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement | null;
    expect(
      numberInput,
      "expected the Delay form's delaySeconds number input",
    ).toBeTruthy();
    expect(numberInput!.value).toBe("5");

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    expect(saveButton, "expected a Save button").toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    // Change the value -> Save enabled.
    await act(async () => {
      setInputValue(numberInput!, "42");
    });
    expect(saveButton.disabled).toBe(false);

    // Click Save -> saveScenarioDefinition called with delaySeconds updated.
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(saveScenarioDefinition).toHaveBeenCalledTimes(1);
    const [savedCpId, savedConnectorId, savedDef] =
      saveScenarioDefinition.mock.calls[0];
    expect(savedCpId).toBe("CP-1");
    expect(savedConnectorId).toBe(1);
    const delayNode = savedDef.nodes.find(
      (n: ScenarioDefinition["nodes"][number]) =>
        n.type === ScenarioNodeType.DELAY,
    );
    expect((delayNode?.data as DelayNodeData | undefined)?.delaySeconds).toBe(
      42,
    );

    expect(saveButton.disabled).toBe(true);
  });

  it("move and delete buttons operate on their own step without changing the current selection", async () => {
    const fixture = linearFixture(); // steps: Status Change, Delay
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    const selectButtons = () =>
      Array.from(
        container.querySelectorAll('button[aria-label^="Select step"]'),
      ) as HTMLElement[];
    const findButton = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === label,
      ) as HTMLButtonElement | undefined;

    // Select the Status Change step (index 1).
    const statusChangeButton = selectButtons().find((b) =>
      b.textContent?.includes("Status Change"),
    )!;
    await act(async () => {
      statusChangeButton.click();
    });
    expect(statusChangeButton.getAttribute("aria-pressed")).toBe("true");

    // Move the *Delay* step (index 2) up — a different step than the one
    // selected. Clicking its move button must not select it.
    const moveDelayUp = findButton("Move step 2 up");
    expect(moveDelayUp, "expected a move-up button for step 2").toBeTruthy();
    await act(async () => {
      moveDelayUp!.click();
    });

    // Order swapped: Delay now first, Status Change now second.
    const afterMove = selectButtons();
    expect(afterMove[0].textContent).toContain("Delay");
    expect(afterMove[1].textContent).toContain("Status Change");

    // Selection followed the Status Change node (still selected), not the
    // step whose move button was clicked.
    expect(afterMove[1].getAttribute("aria-pressed")).toBe("true");
    expect(afterMove[0].getAttribute("aria-pressed")).toBe("false");

    // Delete the (still-selected) Status Change step, now at index 2.
    const deleteStatusChange = findButton("Delete step 2");
    expect(
      deleteStatusChange,
      "expected a delete button for step 2",
    ).toBeTruthy();
    await act(async () => {
      deleteStatusChange!.click();
    });

    expect(container.textContent).not.toContain("Status Change");
    expect(container.textContent).toContain("Delay");
  });

  it("catches a rejecting save, surfaces an error, and keeps the scenario dirty", async () => {
    const fixture = linearFixture();
    const saveScenarioDefinition = vi.fn(async () => {
      throw new Error("network down");
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    const nameInput = container.querySelector(
      'input[aria-label="Scenario name"]',
    ) as HTMLInputElement;
    expect(nameInput, "expected a scenario name input").toBeTruthy();

    // Make the scenario dirty.
    await act(async () => {
      setInputValue(nameInput, "Renamed scenario");
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    // Click Save -> the rejection is caught (no unhandled rejection).
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(saveScenarioDefinition).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to save scenario",
      expect.any(Error),
    );

    // Error surfaced near the meta bar.
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(container.textContent).toContain("Failed to save scenario");

    // Still dirty: Save stays enabled, unsaved-changes indicator still shown.
    expect(saveButton.disabled).toBe(false);
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });

  it("shows a read-only branch banner and hides the add-step control for non-linear scenarios", async () => {
    const fixture = branchFixture();
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s-branch",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain(
      "This scenario has branches — edit it in the classic graph editor",
    );
    expect(container.textContent).not.toContain("+ Add step");
  });
});
