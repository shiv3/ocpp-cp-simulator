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
} from "../../../../cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  renderConsole,
} from "../../../test/harness";
import multiStatusMonitor from "../../../../utils/scenarios/multi-status-monitor.json";
import statusTriggeredActions from "../../../../utils/scenarios/status-triggered-actions.json";

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

function graphNode(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
}

/** The graph editor is lazy-loaded: wait for its first node to render. */
async function waitForGraph(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (container.querySelector(".react-flow__node")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error("the graph editor never rendered");
}

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

/** Let ReactFlow measure and select the nodes it just rendered. */
async function settleGraph(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/** Renames a graph node through the graph's own node panel. */
async function renameGraphNode(
  container: HTMLElement,
  nodeId: string,
  from: string,
  to: string,
): Promise<void> {
  await act(async () => {
    graphNode(container, nodeId)!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
  });
  const labelInput = Array.from(
    container.querySelectorAll<HTMLInputElement>("input"),
  ).find((input) => input.value === from);
  if (!labelInput) throw new Error(`no Label field holding "${from}"`);
  await act(async () => {
    setInputValue(labelInput, to);
  });
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Apply")!
      .click();
  });
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

  it("edits a branching scenario in the graph view and saves it through the page", async () => {
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
    await waitForGraph(container);

    // The graph editor, not a read-only list with a way out to the
    // classic UI.
    expect(container.textContent).not.toContain("classic graph editor");
    expect(container.textContent).not.toContain("Open classic editor");
    for (const id of ["start-1", "trigger-available", "trigger-faulted"]) {
      expect(graphNode(container, id), `graph node ${id}`).not.toBeNull();
    }
    // A single fork is drawable in Steps too, so Steps stays available.
    expect(viewToggle(container, "Graph").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(viewToggle(container, "Steps").disabled).toBe(false);
    // Opening the graph alone (ReactFlow measuring and selecting nodes)
    // is not an edit.
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeNull();

    // Edit one branch's node in the graph's own node panel...
    await act(async () => {
      graphNode(container, "notify-faulted")!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });
    const labelInput = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((input) => input.value === "Send Status");
    expect(labelInput, "the node panel's Label field").toBeTruthy();
    await act(async () => {
      setInputValue(labelInput!, "Report fault");
    });
    const apply = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Apply",
    );
    expect(apply, "the node panel's Apply button").toBeTruthy();
    await act(async () => {
      apply!.click();
    });

    // ...then save once, through the page.
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeTruthy();
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

  it("does not persist anything before the page's Save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const saveScenarioDefinition = vi.fn(async () => fanOutFixture);
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
      await waitForGraph(container);
      const arrange = container.querySelector<HTMLButtonElement>(
        '[aria-label="Auto-arrange nodes"]',
      );
      expect(arrange, "auto-arrange control").toBeTruthy();
      await act(async () => {
        arrange!.click();
      });
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });

      expect(
        container.querySelector('[aria-label="Unsaved changes"]'),
      ).toBeTruthy();
      expect(saveScenarioDefinition).not.toHaveBeenCalled();
      expect(replaceConnectorScenarioDefinitions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opening a graph with an orphan edge is not an edit; the first real edit saves it without the orphan", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withOrphan: ScenarioDefinition = {
      ...fanOutFixture,
      edges: [
        ...fanOutFixture.edges,
        { id: "e-orphan", source: "start-1", target: "deleted-node" },
      ],
    };
    const saveScenarioDefinition = vi.fn(
      async (_cp: string, _c: number | null, def: ScenarioDefinition) => def,
    );
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [withOrphan]),
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=multi-status-monitor&view=graph",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();
    await waitForGraph(container);
    await settleGraph();

    // The editor drops the orphan from its own view only.
    expect(hasUnsavedChanges(container)).toBe(false);
    expect(saveScenarioDefinition).not.toHaveBeenCalled();

    await renameGraphNode(
      container,
      "notify-faulted",
      "Send Status",
      "Report fault",
    );
    expect(hasUnsavedChanges(container)).toBe(true);
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Save")!
        .click();
    });
    await flush();

    expect(saveScenarioDefinition).toHaveBeenCalledTimes(1);
    const saved = saveScenarioDefinition.mock.calls[0][2];
    expect(saved.edges.map((e) => e.id)).not.toContain("e-orphan");
    expect(saved.edges).toHaveLength(fanOutFixture.edges.length);
    warn.mockRestore();
  });

  it("undoing the only graph edit leaves the page clean", async () => {
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fanOutFixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=multi-status-monitor&view=graph",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();
    await waitForGraph(container);
    await settleGraph();

    await renameGraphNode(
      container,
      "notify-faulted",
      "Send Status",
      "Report fault",
    );
    expect(hasUnsavedChanges(container)).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[title*="Undo"]')!
        .click();
    });
    await flush();
    expect(hasUnsavedChanges(container)).toBe(false);
  });

  it("opens a scenario with a loop in the graph view", async () => {
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [loopFixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=status-triggered-actions",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();
    await waitForGraph(container);

    expect(graphNode(container, "delay-10s")).not.toBeNull();
    expect(viewToggle(container, "Steps").disabled).toBe(true);
  });

  it("stays in the graph view when an edit makes the scenario drawable again", async () => {
    // START → A → B → END plus a B → A loop: a shape Steps cannot draw.
    const base = linearFixture();
    const [first, second] = deriveStepLayout(base).main;
    const fixture: ScenarioDefinition = {
      ...base,
      edges: [
        ...base.edges,
        { id: "e-shortcut", source: second.id, target: first.id },
      ],
    };
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });

    const { container, root } = await renderConsole(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();
    await waitForGraph(container);

    expect(viewToggle(container, "Steps").disabled).toBe(true);
    // Select the loop edge and delete it: the graph is linear again.
    // Edges render once ReactFlow has measured the nodes.
    let shortcut: SVGElement | null = null;
    for (let i = 0; i < 100 && !shortcut; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      shortcut = container.querySelector<SVGElement>(
        '.react-flow__edge[data-id="e-shortcut"]',
      );
    }
    expect(shortcut, "the loop edge").not.toBeNull();
    await act(async () => {
      shortcut!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("Delete Selected"))!
        .click();
    });
    await flush();

    expect(
      container.querySelector('.react-flow__edge[data-id="e-shortcut"]'),
    ).toBeNull();
    // Still editing the graph — not ejected to the step list mid-edit.
    expect(container.querySelector(".react-flow__node")).not.toBeNull();
    expect(viewToggle(container, "Graph").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(viewToggle(container, "Steps").disabled).toBe(false);
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
    await waitForGraph(graph.container);
    expect(graph.container.querySelector(".react-flow__node")).not.toBeNull();
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
    await waitForGraph(container);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Auto-arrange nodes"]')!
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
    expect(
      container.querySelector('[aria-label="Unsaved changes"]'),
    ).toBeTruthy();
  });
});
