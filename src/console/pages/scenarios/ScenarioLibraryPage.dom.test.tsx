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
});
