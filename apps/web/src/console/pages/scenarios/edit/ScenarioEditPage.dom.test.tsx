// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import { deriveStepLayout } from "../../../lib/stepLayout";
import {
  ScenarioNodeType,
  type DelayNodeData,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  renderConsole,
} from "../../../test/harness";
import multiStatusMonitor from "@ocpp-cp-simulator/core/utils/scenarios/multi-status-monitor.json";
import statusTriggeredActions from "@ocpp-cp-simulator/core/utils/scenarios/status-triggered-actions.json";

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

/** The shipped templates double as genuinely non-linear fixtures: START
 *  fans out into three parallel branches, and a heartbeat loop. */
const fanOutFixture = multiStatusMonitor as unknown as ScenarioDefinition;
const loopFixture = statusTriggeredActions as unknown as ScenarioDefinition;

function viewToggle(
  container: HTMLElement,
  label: "Steps" | "Graph",
): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="Editor view"] button[data-view="${label.toLowerCase()}"]`,
  );
  if (!button) throw new Error(`expected a "${label}" view toggle`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The card graph's select button of `nodeId`. */
function graphCard(container: HTMLElement, nodeId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-node-id="${nodeId}"] button[aria-label^="Select step"]`,
  );
  if (!button) throw new Error(`no graph card ${nodeId}`);
  return button;
}

/** The node id of the card whose title is `title`. */
function titlesIdOf(container: HTMLElement, title: string): string {
  const card = Array.from(
    container.querySelectorAll<HTMLElement>("[data-node-id]"),
  ).find((el) => el.querySelector(".font-medium")?.textContent === title);
  if (!card) throw new Error(`no graph card titled ${title}`);
  return card.dataset.nodeId!;
}

function buttonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
}

function hasUnsavedChanges(container: HTMLElement): boolean {
  return container.querySelector('[aria-label="Unsaved changes"]') !== null;
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

  it("the inspector header moves the selected step within its lane and deletes it", async () => {
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

    // Nothing selected: no move or delete controls.
    expect(findButton("Delete step 1")).toBeUndefined();

    const statusChangeButton = selectButtons().find((b) =>
      b.textContent?.includes("Status Change"),
    )!;
    await act(async () => {
      statusChangeButton.click();
    });
    expect(statusChangeButton.getAttribute("aria-pressed")).toBe("true");
    // The first step of its lane cannot move up.
    expect(findButton("Move step 1 up")?.disabled).toBe(true);

    await act(async () => {
      findButton("Move step 1 down")!.click();
    });

    // Order swapped, and the selection followed the moved step.
    const afterMove = selectButtons();
    expect(afterMove[0].textContent).toContain("Delay");
    expect(afterMove[1].textContent).toContain("Status Change");
    expect(afterMove[1].getAttribute("aria-pressed")).toBe("true");
    expect(afterMove[0].getAttribute("aria-pressed")).toBe("false");
    expect(findButton("Move step 2 down")?.disabled).toBe(true);

    await act(async () => {
      findButton("Delete step 2")!.click();
    });

    expect(container.textContent).not.toContain("Status Change");
    expect(container.textContent).toContain("Delay");
  });

  it("adds steps under a branch and a parallel branch in the Steps view", async () => {
    const saveScenarioDefinition = vi.fn(
      async (_cp: string, _c: number | null, def: ScenarioDefinition) => def,
    );
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [linearFixture()]),
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    const clickText = async (text: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === text,
      );
      expect(button, `expected a "${text}" button`).toBeTruthy();
      await act(async () => {
        button!.click();
      });
    };

    await clickText("+ Add parallel branch");
    // The chain forks at its last step; the new branch holds one Delay,
    // selected in the inspector.
    expect(
      container.querySelector('[data-testid="step-branches"]'),
    ).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="lane-tag"]')).toHaveLength(
      2,
    );
    expect(
      container.querySelector('input[type="number"]'),
      "the new Delay step's form",
    ).toBeTruthy();

    // + Add step under branch B appends a Meter Value there.
    const addToB = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Add step to"]',
    )[1];
    await act(async () => {
      addToB.click();
    });
    await clickText("Meter Value");

    await clickText("Save");
    await flush();
    const saved = saveScenarioDefinition.mock.calls[0][2];
    const layout = deriveStepLayout(saved);
    expect(layout.supported).toBe(true);
    expect(layout.main).toHaveLength(2);
    expect(
      layout.fork?.branches.map((b) => b.steps.map((n) => n.type)),
    ).toEqual([[], [ScenarioNodeType.DELAY, ScenarioNodeType.METER_VALUE]]);
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

  it("edits a branching scenario in the card graph and saves it through the page", async () => {
    const saveScenarioDefinition = vi.fn(
      async (_cp: string, _c: number | null, def: ScenarioDefinition) => def,
    );
    const replaceConnectorScenarioDefinitions = vi.fn(async () => []);
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fanOutFixture]),
      saveScenarioDefinition,
      replaceConnectorScenarioDefinitions,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=multi-status-monitor&view=graph",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // A single fork is drawable: the Graph view is the card graph, not
    // ReactFlow, and Steps stays available.
    expect(container.querySelector(".react-flow__node")).toBeNull();
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(6);
    expect(container.querySelectorAll('[data-testid="lane-tag"]')).toHaveLength(
      3,
    );
    expect(viewToggle(container, "Graph").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(viewToggle(container, "Steps").disabled).toBe(false);
    expect(hasUnsavedChanges(container)).toBe(false);

    // A click on a card opens it in the inspector.
    await act(async () => {
      graphCard(container, "notify-faulted").click();
    });
    const labelInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((input) => input.value === "Send Status");
    expect(labelInput, "the inspector's Label field").toBeTruthy();
    await act(async () => {
      setInputValue(labelInput!, "Report fault");
    });
    expect(hasUnsavedChanges(container)).toBe(true);

    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    await act(async () => {
      save.click();
    });
    await flush();

    expect(saveScenarioDefinition).toHaveBeenCalledTimes(1);
    const saved = saveScenarioDefinition.mock.calls[0][2];
    expect(saved.id).toBe("multi-status-monitor");
    expect(
      saved.nodes.find((n) => n.id === "notify-faulted")?.data,
    ).toMatchObject({
      label: "Report fault",
      messageType: "StatusNotification",
    });
    expect(saved.edges).toHaveLength(9);
    // Never the replace path, which would delete the connector's other
    // scenarios.
    expect(replaceConnectorScenarioDefinitions).not.toHaveBeenCalled();
  });

  it("adds, moves and deletes steps in the card graph", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [linearFixture()]),
    });
    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1&view=graph",
      { service },
    );
    cleanup = async () => {
      confirm.mockRestore();
      await unmount(root);
    };
    await flush();

    const titles = () =>
      Array.from(container.querySelectorAll("[data-node-id]")).map(
        (el) => el.querySelector(".font-medium")?.textContent,
      );
    expect(titles()).toEqual(["Status Change", "Delay"]);

    // + after the last card: picked from the step picker, then selected.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Add step after step 2"]',
        )!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Meter Value")!
        .click();
    });
    expect(titles()).toEqual(["Status Change", "Delay", "Meter Value"]);
    expect(hasUnsavedChanges(container)).toBe(true);

    // Drag the first card one row down.
    const first = container.querySelector<HTMLElement>(
      "[data-node-id] button",
    )!;
    const drag = (type: string, clientY: number) =>
      act(() => {
        first.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            clientY,
          }),
        );
      });
    drag("pointerdown", 100);
    drag("pointermove", 180);
    drag("pointerup", 180);
    expect(titles()).toEqual(["Delay", "Status Change", "Meter Value"]);

    // Delete on a focused card asks in the page, not window.confirm.
    const delay = graphCard(container, titlesIdOf(container, "Delay"));
    act(() => {
      delay.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const question = container.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Delete step 1");
    await act(async () => {
      buttonByText(question!, "Keep")!.click();
    });
    expect(titles()).toHaveLength(3);
    act(() => {
      delay.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      buttonByText(
        container.querySelector('[role="alertdialog"]')!,
        "Delete",
      )!.click();
    });
    expect(titles()).toEqual(["Status Change", "Meter Value"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opens a scenario with a loop in the card graph, drawing the way back", async () => {
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [loopFixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=status-triggered-actions&view=graph",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // No fallback editor: the card graph, Steps still available.
    expect(container.querySelector(".react-flow__node")).toBeNull();
    expect(viewToggle(container, "Steps").disabled).toBe(false);
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(3);
    const loop = container.querySelector(
      'path[data-link-from="delay-10s"][data-link-to="notification-heartbeat"]',
    );
    expect(loop, "the loop-back arrow").not.toBeNull();
    // A chain closed by a loop cannot fork.
    expect(container.textContent).not.toContain("+ branch");
  });

  it("shows the loop in the Steps view and lets the last step's After-step select change it", async () => {
    const saveScenarioDefinition = vi.fn(
      async (_cp: string, _c: number | null, def: ScenarioDefinition) => def,
    );
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [loopFixture]),
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=status-triggered-actions",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(
      container.querySelector('[data-loop-to="notification-heartbeat"]')
        ?.textContent,
    ).toContain("step 2");

    // Select the Delay step (last of the chain) and open the loop.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-step-id="delay-10s"] button[aria-label^="Select step"]',
        )!
        .click();
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="After this step"]',
    )!;
    expect(select.value).toBe("notification-heartbeat");
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("[data-loop-to]")).toBeNull();
    expect(hasUnsavedChanges(container)).toBe(true);
  });

  it("warns about wiring the executor would only half run, and stays quiet for a clean scenario", async () => {
    // A fork after a step: only START runs branches in parallel.
    const midFork: ScenarioDefinition = {
      ...fanOutFixture,
      edges: [
        { id: "m1", source: "start-1", target: "trigger-available" },
        { id: "m2", source: "trigger-available", target: "notify-available" },
        { id: "m3", source: "trigger-available", target: "trigger-charging" },
        { id: "m4", source: "notify-available", target: "end-available" },
        { id: "m5", source: "trigger-charging", target: "meter-charging" },
        { id: "m6", source: "meter-charging", target: "end-charging" },
        { id: "m7", source: "start-1", target: "trigger-faulted" },
        { id: "m8", source: "trigger-faulted", target: "notify-faulted" },
        { id: "m9", source: "notify-faulted", target: "end-faulted" },
      ],
    };
    const warned = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=multi-status-monitor",
      {
        service: createFakeChargePointService({
          listScenarioDefinitions: vi.fn(async () => [midFork]),
        }),
      },
    );
    await flush();
    const banner = warned.container.querySelector(
      '[data-testid="graph-issues"]',
    );
    expect(banner?.textContent).toContain(
      "only Start runs branches in parallel",
    );
    expect(
      banner?.querySelector('[data-issue="extraOutgoing"]'),
    ).not.toBeNull();
    await unmount(warned.root);

    const clean = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=multi-status-monitor",
      {
        service: createFakeChargePointService({
          listScenarioDefinitions: vi.fn(async () => [fanOutFixture]),
        }),
      },
    );
    cleanup = () => unmount(clean.root);
    await flush();
    expect(
      clean.container.querySelector('[data-testid="graph-issues"]'),
    ).toBeNull();
  });

  it("opens a linear scenario in the step list, and in the graph with view=graph", async () => {
    const fixture = linearFixture();
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });

    const steps = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    await flush();
    expect(steps.container.textContent).toContain("+ Add step");
    expect(steps.container.querySelector(".react-flow__node")).toBeNull();
    expect(
      viewToggle(steps.container, "Steps").getAttribute("aria-pressed"),
    ).toBe("true");
    await unmount(steps.root);

    const graph = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1&view=graph",
      { service },
    );
    cleanup = () => unmount(graph.root);
    await flush();
    // The card graph, not ReactFlow.
    expect(graph.container.querySelectorAll("[data-node-id]")).toHaveLength(2);
    expect(graph.container.querySelector(".react-flow__node")).toBeNull();
    expect(graph.container.textContent).not.toContain("+ Add step");
  });

  it("switching views keeps unsaved graph edits", async () => {
    const fixture = linearFixture();
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    await act(async () => {
      viewToggle(container, "Graph").click();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Add step after step 2"]',
        )!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Meter Value")!
        .click();
    });
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeTruthy();

    await act(async () => {
      viewToggle(container, "Steps").click();
    });
    await flush();

    expect(container.textContent).toContain("+ Add step");
    expect(container.querySelectorAll("[data-step-id]")).toHaveLength(3);
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeTruthy();
  });
  it("puts the inspector beside the steps when the editor is wide enough (a container query)", async () => {
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [linearFixture()]),
    });
    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // jsdom has no layout: the classes are the guard.
    const body = container.querySelector('[data-testid="editor-body"]')!;
    expect(body.classList.contains("@container")).toBe(true);
    const grid = body.querySelector('[data-testid="editor-grid"]')!;
    expect(grid.classList.contains("grid")).toBe(true);
    expect(grid.classList.contains("grid-cols-1")).toBe(true);
    expect(
      grid.classList.contains(
        "@[860px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]",
      ),
    ).toBe(true);
    // Steps column, then the inspector (the empty "Select a step" box too).
    const [steps, inspector] = Array.from(grid.children);
    expect(steps.classList.contains("min-w-0")).toBe(true);
    expect(steps.querySelector("[data-step-id]")).toBeTruthy();
    expect(inspector.textContent).toContain("Select a step");
    expect(inspector.classList.contains("@[860px]:sticky")).toBe(true);
  });
});
