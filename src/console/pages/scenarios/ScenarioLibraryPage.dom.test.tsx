// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  findMenuItem,
  flush,
  openDropdownMenu,
  renderConsole,
} from "../../test/harness";
import { createEmptyScenario, insertStep } from "../../lib/scenarioSteps";
import { ScenarioNodeType } from "../../../cp/application/scenario/ScenarioTypes";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

function snapshot(
  overrides: Partial<ChargePointSnapshot> & { id: string },
): ChargePointSnapshot {
  return {
    status: "Available" as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
    ...overrides,
  };
}

function twoStepScenario(): ScenarioDefinition {
  let def = createEmptyScenario("Demo scenario", "chargePoint");
  def = insertStep(def, 0, ScenarioNodeType.DELAY);
  def = insertStep(def, 1, ScenarioNodeType.DELAY);
  return { ...def, id: "s-demo", description: "A demo fixture" };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Opens a row's `…` menu and returns it. */
async function openRowMenu(scenarioName: string): Promise<HTMLElement> {
  const trigger = document.body.querySelector(
    `button[aria-label="More actions for ${scenarioName}"]`,
  );
  expect(trigger, "expected the row's More actions button").toBeTruthy();
  await openDropdownMenu(trigger!);
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  expect(menu, "expected the row action menu to open").toBeTruthy();
  return menu!;
}

async function selectMenuItem(label: string): Promise<void> {
  const item = findMenuItem(label);
  expect(item, `expected a "${label}" menu item`).toBeTruthy();
  await act(async () => {
    item!.click();
    await Promise.resolve();
  });
}

/** Renders the library with one charge point, CP-1, whose charge-point scope
 *  holds `fixtures`, then flushes the useAllScenarios effect's chained awaits
 *  (listChargePoints -> listScenarioDefinitions per scope). */
async function renderLibraryWith(
  fixtures: ScenarioDefinition[],
  overrides: Parameters<typeof createFakeChargePointService>[0] = {},
) {
  const service = createFakeChargePointService({
    snapshots: [snapshot({ id: "CP-1", connectors: [] })],
    listScenarioDefinitions: vi.fn(async (_cpId: string, connectorId) =>
      connectorId === null ? fixtures : [],
    ),
    ...overrides,
  });
  const rendered = await renderConsole("/scenarios", { service });
  await flush();
  return rendered;
}

describe("ScenarioLibraryPage", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("shows the fixture's name, derived step count, and a Run link scoped to its CP", async () => {
    const { container, root } = await renderLibraryWith([twoStepScenario()]);
    cleanup = () => unmount(root);

    expect(container.textContent).toContain("Demo scenario");
    expect(container.textContent).toContain("2 steps");

    const links = Array.from(container.querySelectorAll("a"));
    const runLink = links.find((a) =>
      (a.getAttribute("href") ?? "").includes("/scenarios/run?"),
    );
    expect(runLink, "expected a Run link in the table row").toBeTruthy();
    expect(runLink!.getAttribute("href")).toContain("cp=CP-1");
    expect(runLink!.getAttribute("href")).toContain("id=s-demo");
  });

  it("renders the row action menu outside the table's scroll container, so the last rows' menu is never clipped (#365)", async () => {
    const { container, root } = await renderLibraryWith([twoStepScenario()]);
    cleanup = () => unmount(root);

    const menu = await openRowMenu("Demo scenario");

    // The shadcn Table wraps <table> in an `overflow-auto` div; a menu inside
    // it gets clipped past the table's bottom edge.
    const scrollContainer = container.querySelector("table")!.parentElement!;
    expect(scrollContainer.className).toContain("overflow-auto");
    expect(scrollContainer.contains(menu)).toBe(false);
  });

  it("row action menu: Duplicate saves a copy and closes the menu", async () => {
    const saveScenarioDefinition = vi.fn(
      async (
        _cpId: string,
        _connectorId: number | null,
        def: ScenarioDefinition,
      ) => def,
    );
    const { root } = await renderLibraryWith([twoStepScenario()], {
      saveScenarioDefinition,
    });
    cleanup = () => unmount(root);

    await openRowMenu("Demo scenario");
    await selectMenuItem("Duplicate");

    expect(saveScenarioDefinition).toHaveBeenCalledWith(
      "CP-1",
      null,
      expect.objectContaining({
        name: expect.stringContaining("Demo scenario"),
      }),
    );
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("row action menu: Delete asks for confirmation, then deletes the scenario", async () => {
    const deleteScenarioDefinition = vi.fn(async () => undefined);
    const { root } = await renderLibraryWith([twoStepScenario()], {
      deleteScenarioDefinition,
    });
    cleanup = () => unmount(root);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await openRowMenu("Demo scenario");
    await selectMenuItem("Delete");

    expect(confirmSpy).toHaveBeenCalledWith('Delete "Demo scenario"?');
    expect(deleteScenarioDefinition).toHaveBeenCalledWith(
      "CP-1",
      null,
      "s-demo",
    );
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows an empty state when there are no scenarios anywhere", async () => {
    const { container, root } = await renderLibraryWith([]);
    cleanup = () => unmount(root);

    expect(container.textContent).toContain("No scenarios");
  });

  it("shows a distinct error state (not the empty state) when loading fails, and Retry recovers", async () => {
    const cp1 = snapshot({ id: "CP-1", connectors: [] });
    let shouldFail = true;
    const listChargePoints = vi.fn(async () => {
      if (shouldFail) throw new Error("boom");
      return [cp1];
    });

    const service = createFakeChargePointService({ listChargePoints });

    const { container, root } = await renderConsole("/scenarios", { service });
    cleanup = () => unmount(root);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Couldn't load scenarios");
    expect(container.textContent).toContain("boom");
    expect(container.textContent).not.toContain("No scenarios");

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryButton, "expected a Retry button").toBeTruthy();

    shouldFail = false;
    await act(async () => {
      retryButton!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Couldn't load scenarios");
    expect(container.textContent).toContain("No scenarios");
  });

  it("handles a rejected save in the dialog-confirm flow: alerts the user, doesn't navigate, and closes the dialog without an unhandled rejection", async () => {
    const cp1 = snapshot({ id: "CP-1", connectors: [] });
    const saveScenarioDefinition = vi.fn(async () => {
      throw new Error("save failed");
    });

    const service = createFakeChargePointService({
      snapshots: [cp1],
      saveScenarioDefinition,
    });

    const { container, root } = await renderConsole("/scenarios", { service });
    cleanup = () => unmount(root);

    // Populate useChargePoints (remote mode subscribes to registry events)
    // so the "+ New scenario" dialog has a charge point to default-select.
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cp1] });
      }
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const newScenarioButton = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "+ New scenario");
    expect(newScenarioButton, "expected a + New scenario button").toBeTruthy();

    await act(async () => {
      newScenarioButton!.click();
      await Promise.resolve();
    });

    // The dialog renders via a Radix Portal into document.body, not into
    // `container`.
    const nameInput =
      document.body.querySelector<HTMLInputElement>("#new-scenario-name");
    expect(nameInput, "expected the dialog's Name field").toBeTruthy();
    setInputValue(nameInput!, "My scenario");

    const createButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Create");
    expect(createButton, "expected a Create button").toBeTruthy();

    await act(async () => {
      createButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveScenarioDefinition).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to save the scenario. Please try again.",
      expect.any(Error),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "Failed to save the scenario. Please try again.",
    );

    // The dialog closes as soon as confirm is pressed (pendingAction is
    // cleared before the save is awaited) even though the save failed, and
    // the page never navigates away to the (nonexistent) new scenario's
    // editor route.
    expect(document.body.querySelector("#new-scenario-name")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "+ New scenario",
      ),
    ).toBe(true);
  });
});
