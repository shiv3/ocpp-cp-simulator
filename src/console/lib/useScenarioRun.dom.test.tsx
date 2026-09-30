// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useScenarioRun } from "./useScenarioRun";
import { createEmptyScenario, insertStep } from "./scenarioSteps";
import {
  createFakeChargePointService,
  flush,
  pushEvent,
  type FakeChargePointService,
} from "../test/harness";
import { DataContext } from "../../data/providers/DataProvider";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioExecutionContext,
} from "../../cp/application/scenario/ScenarioTypes";

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function fixtureScenario(): ScenarioDefinition {
  let def = createEmptyScenario("Demo", "connector", 1);
  def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
  def = insertStep(def, 1, ScenarioNodeType.DELAY);
  return { ...def, id: "s1" };
}

type HookResult = ReturnType<typeof useScenarioRun>;

function Probe({
  cpId,
  connectorId,
  scenario,
  onSnapshot,
}: {
  cpId: string | null;
  connectorId: number | null;
  scenario: ScenarioDefinition | null;
  onSnapshot: (snap: HookResult) => void;
}) {
  const result = useScenarioRun(cpId, connectorId, scenario);
  onSnapshot(result);
  return (
    <div data-testid="probe">
      <button data-testid="start" onClick={() => void result.start()}>
        start
      </button>
      <button data-testid="stop" onClick={() => void result.stop()}>
        stop
      </button>
      <button data-testid="step" onClick={() => void result.step()}>
        step
      </button>
    </div>
  );
}

interface Mounted {
  root: Root;
  current: () => HookResult;
  click: (testId: "start" | "stop" | "step") => Promise<void>;
  rerender: (scenario: ScenarioDefinition | null) => Promise<void>;
}

async function mountProbe(
  service: FakeChargePointService,
  cpId: string | null,
  connectorId: number | null,
  scenario: ScenarioDefinition | null,
): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: HookResult | null = null;

  const render = (target: ScenarioDefinition | null) =>
    root.render(
      <DataContext.Provider
        value={{
          mode: "remote",
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <Probe
          cpId={cpId}
          connectorId={connectorId}
          scenario={target}
          onSnapshot={(snap) => {
            latest = snap;
          }}
        />
      </DataContext.Provider>,
    );

  await act(async () => {
    render(scenario);
  });

  return {
    root,
    current: () => {
      if (!latest) throw new Error("hook snapshot not captured yet");
      return latest;
    },
    click: async (testId) => {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      if (!button) throw new Error(`missing ${testId} button`);
      await act(async () => {
        button.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    rerender: async (target) => {
      await act(async () => {
        render(target);
      });
    },
  };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("useScenarioRun", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("start() calls loadScenario then runScenario with the returned runtime scenarioId", async () => {
    const scenario = fixtureScenario();
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      loadScenario,
      runScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);

    await mounted.click("start");

    expect(loadScenario).toHaveBeenCalledTimes(1);
    expect(loadScenario).toHaveBeenCalledWith("CP-1", 1, scenario);
    expect(runScenario).toHaveBeenCalledTimes(1);
    expect(runScenario).toHaveBeenCalledWith("CP-1", 1, "runtime-s1");
    expect(mounted.current().state).toBe("running");
    expect(mounted.current().runs[0]?.result).toBe("running");
  });

  it("tracks currentNodeId/executedNodeIds from scenario-node-execute, filtered by connectorId + scenarioId", async () => {
    const scenario = fixtureScenario();
    const [step1, step2] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const service = createFakeChargePointService({
      loadScenario,
      runScenario: vi.fn(async () => undefined),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    // Wrong connector — ignored.
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 2,
      scenarioId: "runtime-s1",
      nodeId: step1.id,
    });
    // Wrong scenarioId (e.g. a different run on the same connector) — ignored.
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "some-other-scenario",
      nodeId: step1.id,
    });
    expect(mounted.current().currentNodeId).toBeNull();
    expect(mounted.current().executedNodeIds).toEqual([]);

    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step1.id,
    });
    expect(mounted.current().currentNodeId).toBe(step1.id);
    expect(mounted.current().executedNodeIds).toEqual([step1.id]);

    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step2.id,
    });
    expect(mounted.current().currentNodeId).toBe(step2.id);
    expect(mounted.current().executedNodeIds).toEqual([step1.id, step2.id]);

    // Duplicate event for the same node — deduped, no re-append.
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step2.id,
    });
    expect(mounted.current().executedNodeIds).toEqual([step1.id, step2.id]);
  });

  it("scenario-completed flips state to completed and closes runs[0] as completed", async () => {
    const scenario = fixtureScenario();
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const service = createFakeChargePointService({
      loadScenario,
      runScenario: vi.fn(async () => undefined),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    await pushEvent(service, "CP-1", {
      type: "scenario-completed",
      connectorId: 1,
      scenarioId: "runtime-s1",
    });

    expect(mounted.current().state).toBe("completed");
    expect(mounted.current().runs).toHaveLength(1);
    expect(mounted.current().runs[0].result).toBe("completed");
    expect(mounted.current().runs[0].endedAt).not.toBeNull();
  });

  it("scenario-error sets error + state and records the last executed node as failedNodeId", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const service = createFakeChargePointService({
      loadScenario,
      runScenario: vi.fn(async () => undefined),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step1.id,
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-error",
      connectorId: 1,
      scenarioId: "runtime-s1",
      error: "boom",
    });

    expect(mounted.current().state).toBe("error");
    expect(mounted.current().error).toBe("boom");
    expect(mounted.current().runs[0].result).toBe("error");
    expect(mounted.current().runs[0].failedNodeId).toBe(step1.id);
  });

  it("stop() calls stopScenario with the active runtime scenarioId and closes the run as stopped", async () => {
    const scenario = fixtureScenario();
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const stopScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      loadScenario,
      runScenario: vi.fn(async () => undefined),
      stopScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");
    await mounted.click("stop");

    expect(stopScenario).toHaveBeenCalledTimes(1);
    expect(stopScenario).toHaveBeenCalledWith("CP-1", 1, "runtime-s1");
    expect(mounted.current().state).toBe("idle");
    expect(mounted.current().runs[0].result).toBe("stopped");
  });

  it("step() calls stepScenario with the active runtime scenarioId", async () => {
    const scenario = fixtureScenario();
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const stepScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      loadScenario,
      runScenario: vi.fn(async () => undefined),
      stepScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");
    await mounted.click("step");

    expect(stepScenario).toHaveBeenCalledTimes(1);
    expect(stepScenario).toHaveBeenCalledWith("CP-1", 1, "runtime-s1");
  });

  it("start() is a no-op when there is no scenario loaded yet", async () => {
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const service = createFakeChargePointService({ loadScenario });

    const mounted = await mountProbe(service, "CP-1", 1, null);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    expect(loadScenario).not.toHaveBeenCalled();
    expect(mounted.current().state).toBe("idle");
  });

  it("stop() surfaces a rejected stopScenario as an error instead of silently reporting stopped (Fix 1)", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "runtime-s1" }));
    const runScenario = vi.fn(async () => undefined);
    const stopScenario = vi.fn().mockRejectedValue(new Error("boom"));
    const service = createFakeChargePointService({
      loadScenario,
      runScenario,
      stopScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    await pushEvent(service, "CP-1", {
      type: "scenario-started",
      connectorId: 1,
      scenarioId: "runtime-s1",
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step1.id,
    });

    await mounted.click("stop");

    expect(stopScenario).toHaveBeenCalledTimes(1);
    expect(mounted.current().state).toBe("error");
    expect(mounted.current().error).toContain("boom");
    expect(mounted.current().runs).toHaveLength(1);
    expect(mounted.current().runs[0].result).toBe("error");
    expect(mounted.current().runs[0].endedAt).not.toBeNull();
  });

  it("start() records a run-history entry with result=error when loadScenario rejects (Fix 2)", async () => {
    const scenario = fixtureScenario();
    const loadScenario = vi.fn().mockRejectedValue(new Error("load failed"));
    const service = createFakeChargePointService({ loadScenario });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await mounted.click("start");

    expect(mounted.current().state).toBe("error");
    expect(mounted.current().error).toContain("load failed");
    expect(mounted.current().runs).toHaveLength(1);
    expect(mounted.current().runs[0].result).toBe("error");
    expect(mounted.current().runs[0].startedAt).toBeInstanceOf(Date);
    expect(mounted.current().runs[0].endedAt).not.toBeNull();
  });

  it("start() is a no-op on a rapid second call while the first loadScenario is still pending (Bug 1)", async () => {
    const scenario = fixtureScenario();
    let resolveLoad: ((value: { scenarioId: string }) => void) | undefined;
    const loadScenario = vi.fn(
      () =>
        new Promise<{ scenarioId: string }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      loadScenario,
      runScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);

    // Two rapid calls before `loadScenario` settles — the second must be a
    // no-op, not a re-entry that pushes a second run / issues a second RPC.
    await act(async () => {
      const { start } = mounted.current();
      void start();
      void start();
      await Promise.resolve();
    });

    expect(loadScenario).toHaveBeenCalledTimes(1);
    expect(mounted.current().runs).toHaveLength(1);

    await act(async () => {
      resolveLoad?.({ scenarioId: "runtime-s1" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runScenario).toHaveBeenCalledTimes(1);
    expect(mounted.current().runs).toHaveLength(1);
    expect(mounted.current().state).toBe("running");
    expect(mounted.current().runs[0].result).toBe("running");
  });

  it("start() does not attach a stale currentNodeId as failedNodeId when a retry's loadScenario rejects (Bug 2)", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const loadScenario = vi
      .fn()
      .mockResolvedValueOnce({ scenarioId: "runtime-s1" })
      .mockRejectedValueOnce(new Error("retry load failed"));
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      loadScenario,
      runScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);

    // First run completes at step1.
    await mounted.click("start");
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step1.id,
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-completed",
      connectorId: 1,
      scenarioId: "runtime-s1",
    });
    expect(mounted.current().currentNodeId).toBe(step1.id);

    // Retry: loadScenario rejects before any node of the new run executes.
    await mounted.click("start");

    expect(mounted.current().state).toBe("error");
    expect(mounted.current().error).toContain("retry load failed");
    expect(mounted.current().runs).toHaveLength(2);
    expect(mounted.current().runs[0].result).toBe("error");
    expect(mounted.current().runs[0].failedNodeId).toBeUndefined();
  });
});

function waitingStatus(
  scenarioId: string,
  currentNodeId: string,
  executedNodes: string[],
  overrides: Partial<ScenarioExecutionContext> = {},
): ScenarioExecutionContext {
  return {
    scenarioId,
    state: "waiting",
    mode: "oneshot",
    currentNodeId,
    executedNodes,
    loopCount: 0,
    runId: "run-42",
    currentNodeStartedAt: 1_000,
    expectation: {
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "RemoteStopTransaction",
      timeoutMs: 60_000,
      nodeId: currentNodeId,
    },
    ...overrides,
  };
}

describe("useScenarioRun — attaching to a run already live in the runtime (#366)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("hydrates state, node position, expectation and runId from getScenarioStatus on mount", async () => {
    const scenario = fixtureScenario();
    const [step1, step2] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const getScenarioStatus = vi.fn(async () =>
      waitingStatus("s1", step2.id, [step1.id, step2.id]),
    );
    const loadScenario = vi.fn(async () => ({ scenarioId: "s1" }));
    const runScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      getScenarioStatus,
      loadScenario,
      runScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();

    expect(getScenarioStatus).toHaveBeenCalledWith("CP-1", 1, "s1");
    const snap = mounted.current();
    expect(snap.hydrated).toBe(true);
    expect(snap.state).toBe("waiting");
    expect(snap.currentNodeId).toBe(step2.id);
    expect(snap.executedNodeIds).toEqual([step1.id, step2.id]);
    expect(snap.runId).toBe("run-42");
    expect(snap.expectation?.action).toBe("RemoteStopTransaction");
    expect(snap.expectation?.timeoutMs).toBe(60_000);
    expect(snap.currentNodeStartedAt).toBe(1_000);
    expect(snap.runs).toHaveLength(1);
    expect(snap.runs[0]).toMatchObject({
      result: "running",
      endedAt: null,
      attached: true,
      runId: "run-42",
    });
    // Opening the page must never start a run.
    expect(loadScenario).not.toHaveBeenCalled();
    expect(runScenario).not.toHaveBeenCalled();
  });

  it("stop() after hydration stops the attached run and closes it as stopped", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const stopScenario = vi.fn(async () => undefined);
    const service = createFakeChargePointService({
      getScenarioStatus: vi.fn(async () =>
        waitingStatus("s1", step1.id, [step1.id]),
      ),
      stopScenario,
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();
    await mounted.click("stop");

    expect(stopScenario).toHaveBeenCalledWith("CP-1", 1, "s1");
    expect(mounted.current().state).toBe("idle");
    expect(mounted.current().expectation).toBeNull();
    expect(mounted.current().runs[0].result).toBe("stopped");
  });

  it("stays idle with an empty history when the runtime reports no live run", async () => {
    const scenario = fixtureScenario();
    const service = createFakeChargePointService({
      getScenarioStatus: vi.fn(async () => null),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();

    expect(mounted.current().hydrated).toBe(true);
    expect(mounted.current().state).toBe("idle");
    expect(mounted.current().runs).toEqual([]);
    expect(mounted.current().runId).toBeNull();
  });

  it("does not attach a terminal status (a finished run is not re-opened as live)", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const service = createFakeChargePointService({
      getScenarioStatus: vi.fn(async () =>
        waitingStatus("s1", step1.id, [step1.id], {
          state: "completed",
          expectation: null,
        }),
      ),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();

    expect(mounted.current().state).toBe("idle");
    expect(mounted.current().runs).toEqual([]);
  });

  it("ignores a hydration response that settles after the viewed scenario changed", async () => {
    const first = fixtureScenario();
    const second = { ...fixtureScenario(), id: "s2" };
    const [step1] = first.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    let resolveFirst: (v: ScenarioExecutionContext | null) => void = () => {};
    const getScenarioStatus = vi.fn(
      (_cp: string, _conn: number, scenarioId: string) =>
        scenarioId === "s1"
          ? new Promise<ScenarioExecutionContext | null>((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve(null),
    );
    const service = createFakeChargePointService({ getScenarioStatus });

    const mounted = await mountProbe(service, "CP-1", 1, first);
    cleanup = () => unmount(mounted.root);
    await mounted.rerender(second);
    await flush();

    await act(async () => {
      resolveFirst(waitingStatus("s1", step1.id, [step1.id]));
    });
    await flush();

    expect(mounted.current().state).toBe("idle");
    expect(mounted.current().runs).toEqual([]);
    expect(mounted.current().currentNodeId).toBeNull();
  });

  it("attaches when the viewed scenario is started outside this page while it is open", async () => {
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const getScenarioStatus = vi.fn(async () => null);
    const service = createFakeChargePointService({ getScenarioStatus });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();
    expect(mounted.current().state).toBe("idle");

    // A different scenario starting on the same connector is not ours.
    await pushEvent(service, "CP-1", {
      type: "scenario-started",
      connectorId: 1,
      scenarioId: "other",
    });
    expect(mounted.current().state).toBe("idle");

    await pushEvent(service, "CP-1", {
      type: "scenario-started",
      connectorId: 1,
      scenarioId: "s1",
    });
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "s1",
      nodeId: step1.id,
    });

    expect(mounted.current().state).toBe("running");
    expect(mounted.current().currentNodeId).toBe(step1.id);
    expect(mounted.current().runs).toHaveLength(1);
    expect(mounted.current().runs[0]).toMatchObject({
      result: "running",
      attached: true,
    });
  });

  it("re-queries the runtime status after a node-execute so a parked run reads waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scenario = fixtureScenario();
    const [step1, step2] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => null,
    );
    const service = createFakeChargePointService({
      getScenarioStatus,
      loadScenario: vi.fn(async () => ({ scenarioId: "runtime-s1" })),
      runScenario: vi.fn(async () => undefined),
    });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();
    await mounted.click("start");

    getScenarioStatus.mockResolvedValue(
      waitingStatus("runtime-s1", step2.id, [step1.id, step2.id]),
    );
    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "runtime-s1",
      nodeId: step2.id,
    });
    expect(mounted.current().state).toBe("running");

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();

    expect(getScenarioStatus).toHaveBeenLastCalledWith("CP-1", 1, "runtime-s1");
    expect(mounted.current().state).toBe("waiting");
    expect(mounted.current().expectation?.action).toBe("RemoteStopTransaction");
    expect(mounted.current().runId).toBe("run-42");
  });

  it("a status refresh landing after scenario-completed does not revert the terminal state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scenario = fixtureScenario();
    const [step1] = scenario.nodes.filter(
      (n) =>
        n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
    );
    let resolveRefresh: (v: ScenarioExecutionContext | null) => void = () => {};
    const getScenarioStatus = vi
      .fn()
      .mockResolvedValueOnce(waitingStatus("s1", step1.id, [step1.id]))
      .mockImplementationOnce(
        () =>
          new Promise<ScenarioExecutionContext | null>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const service = createFakeChargePointService({ getScenarioStatus });

    const mounted = await mountProbe(service, "CP-1", 1, scenario);
    cleanup = () => unmount(mounted.root);
    await flush();
    expect(mounted.current().state).toBe("waiting");

    await pushEvent(service, "CP-1", {
      type: "scenario-node-execute",
      connectorId: 1,
      scenarioId: "s1",
      nodeId: step1.id,
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    // The refresh is in flight when the run completes.
    await pushEvent(service, "CP-1", {
      type: "scenario-completed",
      connectorId: 1,
      scenarioId: "s1",
    });
    await act(async () => {
      resolveRefresh(waitingStatus("s1", step1.id, [step1.id]));
    });
    await flush();

    expect(mounted.current().state).toBe("completed");
    expect(mounted.current().expectation).toBeNull();
    expect(mounted.current().runs[0].result).toBe("completed");
  });

  describe("wait controls (#240)", () => {
    async function mountWaiting(
      getScenarioStatus: () => Promise<ScenarioExecutionContext | null>,
    ) {
      const scenario = fixtureScenario();
      const [step1, step2] = scenario.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      );
      const service = createFakeChargePointService({
        getScenarioStatus: vi.fn(getScenarioStatus),
        loadScenario: vi.fn(async () => ({ scenarioId: "runtime-s1" })),
        runScenario: vi.fn(async () => undefined),
      });
      const mounted = await mountProbe(service, "CP-1", 1, scenario);
      cleanup = () => unmount(mounted.root);
      await flush();
      return { mounted, service, step1: step1!, step2: step2! };
    }

    it("exposes the runtime's wait deadline", async () => {
      const scenario = fixtureScenario();
      const [step1, step2] = scenario.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      );
      const { mounted } = await mountWaiting(async () =>
        waitingStatus("s1", step2!.id, [step1!.id, step2!.id], {
          waitDeadlineAt: 99_000,
        }),
      );

      expect(mounted.current().waitDeadlineAt).toBe(99_000);
    });

    it("acts on the tracked runtime scenario and re-reads its status", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { mounted, service, step1, step2 } = await mountWaiting(
          async () => null,
        );
        await mounted.click("start");
        await pushEvent(service, "CP-1", {
          type: "scenario-node-execute",
          connectorId: 1,
          scenarioId: "runtime-s1",
          nodeId: step2.id,
        });

        vi.mocked(service.getScenarioStatus).mockResolvedValue(
          waitingStatus("runtime-s1", step2.id, [step1.id, step2.id], {
            waitDeadlineAt: 120_000,
          }),
        );
        await act(async () => {
          await mounted.current().controlWait("extend", 30);
          await mounted.current().controlWait("retry");
          await mounted.current().controlWait("continue");
          vi.advanceTimersByTime(250);
        });
        await flush();

        expect(service.extendScenarioWait).toHaveBeenCalledWith(
          "CP-1",
          1,
          "runtime-s1",
          30,
        );
        expect(service.retryScenarioWait).toHaveBeenCalledWith(
          "CP-1",
          1,
          "runtime-s1",
        );
        expect(service.continueScenarioWait).toHaveBeenCalledWith(
          "CP-1",
          1,
          "runtime-s1",
        );
        expect(mounted.current().waitDeadlineAt).toBe(120_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-reads the status when another client changes the wait", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const scenario = fixtureScenario();
        const [step1, step2] = scenario.nodes.filter(
          (n) =>
            n.type !== ScenarioNodeType.START &&
            n.type !== ScenarioNodeType.END,
        );
        const status = waitingStatus("s1", step2!.id, [step1!.id, step2!.id], {
          waitDeadlineAt: 90_000,
        });
        const { mounted, service } = await mountWaiting(async () => status);
        expect(mounted.current().waitDeadlineAt).toBe(90_000);

        vi.mocked(service.getScenarioStatus).mockResolvedValue({
          ...status,
          waitDeadlineAt: 150_000,
        });
        await pushEvent(service, "CP-1", {
          type: "scenario-wait-changed",
          connectorId: 1,
          scenarioId: "s1",
          runId: "run-42",
          nodeId: step2!.id,
          kind: "extend",
        });
        await act(async () => {
          vi.advanceTimersByTime(250);
        });
        await flush();

        expect(mounted.current().waitDeadlineAt).toBe(150_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
