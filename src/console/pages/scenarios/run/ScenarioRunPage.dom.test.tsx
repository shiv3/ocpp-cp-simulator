// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../../../cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  type FakeChargePointService,
} from "../../../test/harness";
import { renderConsole } from "../../../test/harness";
import type { ChargePointEvent } from "../../../../data/interfaces/ChargePointService";

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

async function pushEvent(
  service: FakeChargePointService,
  cpId: string,
  event: ChargePointEvent,
): Promise<void> {
  const handlers = service.__handlers.subscribe.get(cpId);
  if (!handlers || handlers.size === 0) {
    throw new Error(`no subscribe handler recorded for ${cpId}`);
  }
  await act(async () => {
    handlers.forEach((handler) => handler(event));
  });
}

function linearFixture(): ScenarioDefinition {
  let def = createEmptyScenario("Boot demo", "connector", 1);
  def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
  def = insertStep(def, 1, ScenarioNodeType.DELAY);
  return { ...def, id: "s1" };
}

describe("ScenarioRunPage", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    // jsdom doesn't implement `Element.scrollTo` — `LogViewer`'s auto-scroll
    // effect calls it unconditionally on mount. Every other place that
    // mounts `LogViewer` in this repo's dom tests happens to do so inside a
    // lazily-rendered tab (e.g. `CpDetailPage`'s Logs tab isn't the default
    // active one), so this gap hasn't surfaced before; here the log tail is
    // always mounted. Scoped to this file rather than the shared
    // `src/test/setup.dom.ts` since `LogViewer` itself is out of scope
    // (`src/components/*` is off-limits for Task 8).
    if (typeof Element.prototype.scrollTo !== "function") {
      Element.prototype.scrollTo = () => {};
    }
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("starts a run, tracks node-execute progress, and closes the run as completed", async () => {
    const fixture = linearFixture();
    const [step1, step2] = fixture.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-1" }));
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      loadScenario,
      runScenario,
    });

    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Boot demo");
    expect(container.textContent).toContain("CP-1 · C1");
    expect(container.textContent).toContain("Idle");
    expect(container.textContent).toContain("Status Change");
    expect(container.textContent).toContain("Delay");

    const findButton = (label: string): HTMLButtonElement => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      ) as HTMLButtonElement | undefined;
      if (!button) throw new Error(`expected a "${label}" button`);
      return button;
    };

    // Step is disabled until a run is active.
    expect(findButton("Step").disabled).toBe(true);

    await act(async () => {
      findButton("Start").click();
    });
    await flush();

    expect(loadScenario).toHaveBeenCalledWith("CP-1", 1, fixture);
    expect(runScenario).toHaveBeenCalledWith("CP-1", 1, "runtime-1");
    expect(container.textContent).toContain("Running");
    // The Start/Stop toggle now reads "Stop", and Step is enabled.
    expect(() => findButton("Start")).toThrow();
    expect(findButton("Stop")).toBeTruthy();
    expect(findButton("Step").disabled).toBe(false);

    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-1",
      nodeId: step1.id,
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-1",
      nodeId: step2.id,
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-completed",
      connectorId: 1,
      scenarioId: "runtime-1",
    });

    expect(container.textContent).toContain("Completed");
    expect(container.textContent).not.toContain("Running");
    // Run history shows one closed, completed entry.
    expect(container.textContent).toContain("completed");
    // Back to idle controls.
    expect(findButton("Start")).toBeTruthy();
    expect(findButton("Step").disabled).toBe(true);
  });

  it("shows a not-found empty state for an unknown scenario id", async () => {
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=missing",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Scenario not found");
    expect(container.textContent).toContain("← Back to scenarios");
  });
});
