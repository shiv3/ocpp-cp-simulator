// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  // Tracks whether THIS file installed the polyfill below, so afterAll only
  // removes it if it's the one that added it (and not, say, a real
  // `scrollTo` implementation some other environment already provided).
  let installedScrollToPolyfill = false;

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
      installedScrollToPolyfill = true;
    }
  });

  afterAll(() => {
    // Undo the polyfill so it doesn't leak into other test files sharing
    // this vitest worker/jsdom global — otherwise "scoped to this file"
    // above would be a false claim.
    if (installedScrollToPolyfill) {
      delete (Element.prototype as { scrollTo?: () => void }).scrollTo;
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

    // No Step control is rendered at all — `runScenario` always runs
    // oneshot, so `ScenarioExecutor` never reaches its "stepping" state and
    // `stepScenario` would be a dead click (see ScenarioRunPage.tsx's
    // comment). Not just disabled — genuinely absent.
    expect(() => findButton("Step")).toThrow();

    await act(async () => {
      findButton("Start").click();
    });
    await flush();

    expect(loadScenario).toHaveBeenCalledWith("CP-1", 1, fixture);
    expect(runScenario).toHaveBeenCalledWith("CP-1", 1, "runtime-1");
    expect(container.textContent).toContain("Running");
    // The Start/Stop toggle now reads "Stop"; still no Step control.
    expect(() => findButton("Start")).toThrow();
    expect(findButton("Stop")).toBeTruthy();
    expect(() => findButton("Step")).toThrow();

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
    // Back to idle controls; still no Step button.
    expect(findButton("Start")).toBeTruthy();
    expect(() => findButton("Step")).toThrow();
  });

  it("disables Start and shows an explanatory banner for a charge-point-scope scenario (empty connector param)", async () => {
    const fixture: ScenarioDefinition = {
      ...linearFixture(),
      targetType: "chargePoint",
    };
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-1" }));
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      loadScenario,
      runScenario,
    });

    // Mirrors buildScenarioUrl("run", cpId, null, scenarioId): the
    // `connector` query param is present but empty for CP-scope scenarios.
    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Boot demo");
    // TargetChip renders cpId only (no "· C<n>") when connectorId is null.
    expect(container.textContent).toContain("CP-1");
    expect(container.textContent).not.toContain("CP-1 · C");

    const startButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Start",
    ) as HTMLButtonElement | undefined;
    expect(startButton, 'expected a "Start" button').toBeTruthy();
    expect(startButton!.disabled).toBe(true);

    expect(container.textContent).toContain(
      "This is a charge-point-scope scenario",
    );

    // Clicking (even though disabled) must never reach the RPCs — belt and
    // suspenders alongside the `disabled` assertion above.
    await act(async () => {
      startButton!.click();
    });
    await flush();
    expect(loadScenario).not.toHaveBeenCalled();
    expect(runScenario).not.toHaveBeenCalled();
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
