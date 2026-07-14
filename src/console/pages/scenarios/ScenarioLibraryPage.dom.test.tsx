// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
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

describe("ScenarioLibraryPage", () => {
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

  it("shows the fixture's name, derived step count, and a Run link scoped to its CP", async () => {
    const cp1 = snapshot({ id: "CP-1", connectors: [] });
    const fixture = twoStepScenario();

    const byScope: Record<string, ScenarioDefinition[]> = {
      "CP-1:cp": [fixture],
    };

    const service = createFakeChargePointService({
      snapshots: [cp1],
      listScenarioDefinitions: vi.fn(
        async (cpId: string, connectorId: number | null) =>
          byScope[`${cpId}:${connectorId ?? "cp"}`] ?? [],
      ),
    });

    const { container, root } = await renderConsole("/scenarios", { service });
    cleanup = () => unmount(root);

    // Flush the useAllScenarios effect's chained awaits (listChargePoints ->
    // listScenarioDefinitions per scope).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Demo scenario");
    expect(container.textContent).toContain("2 steps");

    const links = Array.from(container.querySelectorAll("a"));
    const runLink = links.find((a) =>
      (a.getAttribute("href") ?? "").includes("/scenarios/run"),
    );
    expect(runLink, "expected a Run link in the table row").toBeTruthy();
    expect(runLink!.getAttribute("href")).toContain("cp=CP-1");
    expect(runLink!.getAttribute("href")).toContain("id=s-demo");
  });

  it("shows an empty state when there are no scenarios anywhere", async () => {
    const cp1 = snapshot({ id: "CP-1", connectors: [] });
    const service = createFakeChargePointService({ snapshots: [cp1] });

    const { container, root } = await renderConsole("/scenarios", { service });
    cleanup = () => unmount(root);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

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

    alertSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
