// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEmptyScenario, insertStep } from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioExecutionContext,
} from "../../../../cp/application/scenario/ScenarioTypes";
import {
  createFakeChargePointService,
  flush,
  pushEvent,
  renderConsole,
  type ReportedLocation,
} from "../../../test/harness";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
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
    expect(container.textContent).toContain("CP-1 #1");
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
    // The target line shows the cpId only (no "#<n>") when connectorId is null.
    expect(container.textContent).toContain("CP-1");
    expect(container.textContent).not.toContain("CP-1 #");

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

  it("attaches to a run already live in the runtime instead of showing a fresh idle state (#366)", async () => {
    const fixture = linearFixture();
    const [step1, step2] = fixture.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "waiting",
        mode: "oneshot",
        currentNodeId: step2.id,
        executedNodes: [step1.id, step2.id],
        loopCount: 0,
        runId: "run-42",
        currentNodeStartedAt: Date.now(),
        expectation: {
          type: "ocpp_call",
          direction: "CSMS_TO_CP",
          action: "RemoteStopTransaction",
          timeoutMs: 60_000,
          nodeId: step2.id,
        },
      }),
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "s1" }));
    const runScenario = vi.fn(async () => undefined);
    const stopScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      getScenarioStatus,
      loadScenario,
      runScenario,
      stopScenario,
    });

    // The URL "Open run" builds from the Active scenarios panel.
    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1&run=run-42",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(getScenarioStatus).toHaveBeenCalledWith("CP-1", 1, "s1");
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).not.toContain("Idle");
    expect(container.textContent).toContain("run-42");
    expect(container.textContent).not.toContain("no longer active");

    // Timeline is positioned on the runtime's current node.
    const phases = Array.from(container.querySelectorAll("[data-step-id]")).map(
      (el) => el.getAttribute("data-phase"),
    );
    expect(phases).toEqual(["done", "current"]);

    // Waiting expectation and its timeout.
    expect(container.textContent).toContain("Waiting for");
    expect(container.textContent).toContain("RemoteStopTransaction");
    expect(container.textContent).toContain("Timeout in");

    // Run history lists the attached run rather than "No runs yet".
    expect(container.textContent).not.toContain("No runs yet this session");
    expect(container.textContent).toContain("attached");

    // Opening the page never starts a run.
    expect(loadScenario).not.toHaveBeenCalled();
    expect(runScenario).not.toHaveBeenCalled();

    // Stop acts on the existing run.
    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Stop",
    ) as HTMLButtonElement | undefined;
    expect(stopButton, 'expected a "Stop" button').toBeTruthy();
    await act(async () => {
      stopButton!.click();
    });
    await flush();
    expect(stopScenario).toHaveBeenCalledWith("CP-1", 1, "s1");
    expect(container.textContent).toContain("stopped");
  });

  it("offers the wait controls on an attached waiting run (#240)", async () => {
    const fixture = linearFixture();
    const [step1, step2] = fixture.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const continueScenarioWait = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      getScenarioStatus: vi.fn(
        async (): Promise<ScenarioExecutionContext | null> => ({
          scenarioId: "s1",
          state: "waiting",
          mode: "oneshot",
          currentNodeId: step2.id,
          executedNodes: [step1.id, step2.id],
          loopCount: 0,
          runId: "run-42",
          currentNodeStartedAt: Date.now() - 55_000,
          waitDeadlineAt: Date.now() + 35_000,
          expectation: {
            type: "ocpp_call",
            direction: "CSMS_TO_CP",
            action: "RemoteStopTransaction",
            timeoutMs: 60_000,
            nodeId: step2.id,
          },
        }),
      ),
      continueScenarioWait,
    });

    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1&run=run-42",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    // The countdown follows the runtime's (extended) deadline.
    expect(container.textContent).toMatch(/Timeout in 0:(34|35)/);
    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining(["+30 s", "Retry", "Continue"]),
    );

    const continueButton = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Continue");
    await act(async () => {
      continueButton!.click();
    });
    await flush();
    expect(continueScenarioWait).toHaveBeenCalledWith("CP-1", 1, "s1");
  });

  it("says so when the run named in the URL is no longer active", async () => {
    const fixture = linearFixture();
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      getScenarioStatus: vi.fn(async () => null),
    });

    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1&run=run-old",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Idle");
    expect(container.textContent).toContain("Run run-old is no longer active");
  });

  it("names the current run when the one in the URL was superseded", async () => {
    const fixture = linearFixture();
    const [step1] = fixture.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
      getScenarioStatus: vi.fn(
        async (): Promise<ScenarioExecutionContext | null> => ({
          scenarioId: "s1",
          state: "running",
          mode: "oneshot",
          currentNodeId: step1.id,
          executedNodes: [step1.id],
          loopCount: 0,
          runId: "run-new",
        }),
      ),
    });

    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1&run=run-old",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Run run-old is no longer active");
    expect(container.textContent).toContain("run-new");
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
    expect(container.textContent).toContain("← Back");
  });

  it("is read-only: no message log, a Steps | Graph switch in ?view=, and the run history", async () => {
    const fixture = linearFixture();
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [fixture]),
    });
    let location: ReportedLocation | null = null;
    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1",
      {
        service,
        onLocationChange: (l) => {
          location = l;
        },
      },
    );
    cleanup = () => unmount(root);
    await flush();

    // The message log lives on the charge point page, not here.
    expect(container.textContent).not.toContain("Clear");
    expect(container.querySelector('input[placeholder*="Search"]')).toBeNull();
    expect(container.textContent).toContain("Run history");
    expect(container.textContent).toMatch(/No runs/);

    // Back defaults to the Scenarios page.
    const back = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "← Back",
    );
    expect(back?.getAttribute("href")).toBe("/scenarios");

    // Edit scenario opens the editor on the same target.
    const edit = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit scenario"),
    );
    expect(edit?.getAttribute("href")).toBe(
      "/scenarios/edit?cp=CP-1&connector=1&id=s1",
    );

    // Steps by default; Graph draws the cards and writes ?view=graph.
    const view = container.querySelector('[role="group"][aria-label="View"]')!;
    expect(view).toBeTruthy();
    expect(container.querySelectorAll("[data-step-id]")).toHaveLength(2);
    const graph = Array.from(view.querySelectorAll("button")).find(
      (b) => b.textContent === "Graph",
    )!;
    await act(async () => graph.click());
    await flush();
    expect(new URLSearchParams(location!.search).get("view")).toBe("graph");
    expect(location!.type).toBe("REPLACE");
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-step-id]")).toHaveLength(0);
  });

  it("falls back to the flat timeline for a scenario it cannot lay out", async () => {
    let def = linearFixture();
    const [a, b] = def.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    // b → a: a loop.
    def = {
      ...def,
      edges: [...def.edges, { id: "loop", source: b.id, target: a.id }],
    };
    const service = createFakeChargePointService({
      listScenarioDefinitions: vi.fn(async () => [def]),
    });
    const { container, root } = await renderConsole(
      "/scenarios/run?cp=CP-1&connector=1&id=s1",
      { service },
    );
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("order approximate");
    expect(container.querySelectorAll("[data-step-id]")).toHaveLength(0);
  });
});
