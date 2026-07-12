// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useScenarioRun } from "./useScenarioRun";
import { createEmptyScenario, insertStep } from "./scenarioSteps";
import {
  createFakeChargePointService,
  type FakeChargePointService,
} from "../test/harness";
import { DataContext } from "../../data/providers/DataProvider";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";

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

  await act(async () => {
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
          scenario={scenario}
          onSnapshot={(snap) => {
            latest = snap;
          }}
        />
      </DataContext.Provider>,
    );
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
  };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

/** Pushes a synthetic event through every handler the fake service recorded
 *  via `subscribe(cpId, handler)` — this is what lets a test simulate
 *  scenario progress without a real runtime. */
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
});
