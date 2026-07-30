// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../../../cp/application/scenario/ScenarioTypes";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function connector(
  overrides: Partial<ChargePointSnapshot["connectors"][number]> & {
    id: number;
  },
): ChargePointSnapshot["connectors"][number] {
  return {
    status: OCPPStatus.Available,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: false,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ChargePointSnapshot> & { id: string },
): ChargePointSnapshot {
  return {
    status: OCPPStatus.Available,
    error: "",
    connectors: [],
    ...overrides,
  };
}

const scenarioDefinitionFixture: ScenarioDefinition = {
  id: "s1",
  name: "Cert probe",
  targetType: "connector",
  targetId: 1,
  nodes: [
    {
      id: "n1",
      type: "start",
      data: { label: "Start" },
      position: { x: 0, y: 0 },
    },
    {
      id: "n2",
      type: "remoteStartTrigger",
      data: { label: "Wait for remote start" },
      position: { x: 0, y: 100 },
    },
  ],
  edges: [],
  createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
};

describe("ActiveScenarioPanel", () => {
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

  it("shows active scenario with waiting state and expectation details", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const nowTime = Date.now();
    const startTime = nowTime - 5000; // Started 5 seconds ago

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Cert probe", active: true },
    ]);

    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "waiting",
        mode: "oneshot",
        currentNodeId: "n2",
        executedNodes: ["n1"],
        loopCount: 0,
        runId: "run-1",
        expectation: {
          type: "ocpp_call" as const,
          action: "RemoteStartTransaction",
          timeoutMs: 60000,
          nodeId: "n2",
        },
        currentNodeStartedAt: startTime,
      }),
    );

    const getScenario = vi.fn(async () => scenarioDefinitionFixture);

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getScenarioStatus,
      getScenario,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    // Panel should exist and show the scenario name
    expect(container.textContent).toContain("Active scenarios");
    expect(container.textContent).toContain("Cert probe");

    // Waiting badge should be visible
    expect(container.textContent).toContain("waiting");

    // Connector info visible
    expect(container.textContent).toContain("Connector #1");

    // Current step info visible
    expect(container.textContent).toContain("Wait for remote start");
    expect(container.textContent).toContain("1/2 steps");

    // Waiting expectation details
    expect(container.textContent).toContain("Waiting for");
    expect(container.textContent).toContain("RemoteStartTransaction");

    // Stop button should exist
    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Stop",
    );
    expect(stopButton, "expected a Stop button").toBeTruthy();

    // Open run link should exist
    const openLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open run"),
    );
    expect(openLink, "expected an Open run link").toBeTruthy();
    expect(openLink?.href).toContain("/scenarios/run?cp=CP-1");
    expect(openLink?.href).toContain("connector=1");
    expect(openLink?.href).toContain("id=s1");
  });

  it("renders nothing when listScenarios returns only inactive items", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Inactive scenario", active: false },
    ]);

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    // Panel should not be visible when there are no active scenarios
    expect(container.textContent).not.toContain("Active scenarios");
  });

  it("shows running state badge correctly", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Test scenario", active: true },
    ]);

    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "running" as const,
        mode: "oneshot" as const,
        currentNodeId: "n1",
        executedNodes: ["n1"],
        loopCount: 0,
        runId: "run-1",
        currentNodeStartedAt: Date.now(),
      }),
    );

    const getScenario = vi.fn(async () => scenarioDefinitionFixture);

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getScenarioStatus,
      getScenario,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("running");
    expect(container.textContent).not.toContain("waiting");
  });

  it("stopScenario is called when Stop button is clicked", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Test scenario", active: true },
    ]);

    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "running" as const,
        mode: "oneshot" as const,
        currentNodeId: "n1",
        executedNodes: ["n1"],
        loopCount: 0,
        runId: "run-1",
        currentNodeStartedAt: Date.now(),
      }),
    );

    const getScenario = vi.fn(async () => scenarioDefinitionFixture);
    const stopScenario = vi.fn(async () => {});

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getScenarioStatus,
      getScenario,
      stopScenario,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Stop",
    );
    expect(stopButton, "expected a Stop button").toBeTruthy();

    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(stopScenario).toHaveBeenCalledWith("CP-1", 1, "s1");
  });

  it("handles waiting state with no timeout", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Test scenario", active: true },
    ]);

    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "waiting" as const,
        mode: "oneshot" as const,
        currentNodeId: "n2",
        executedNodes: ["n1"],
        loopCount: 0,
        runId: "run-1",
        expectation: {
          type: "connector_status" as const,
          targetStatus: "Charging",
          nodeId: "n2",
        },
        currentNodeStartedAt: Date.now(),
      }),
    );

    const getScenario = vi.fn(async () => scenarioDefinitionFixture);

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getScenarioStatus,
      getScenario,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Waiting for");
    expect(container.textContent).toContain("Charging");
    expect(container.textContent).toContain("No timeout");
  });

  it("parent re-renders do not retrigger scenario fetches; scenario events do (fetch-loop regression)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });

    const listScenarios = vi.fn(async () => [
      { scenarioId: "s1", name: "Cert probe", active: true },
    ]);

    const getScenarioStatus = vi.fn(
      async (): Promise<ScenarioExecutionContext | null> => ({
        scenarioId: "s1",
        state: "running" as const,
        mode: "oneshot" as const,
        currentNodeId: "n1",
        executedNodes: ["n1"],
        loopCount: 0,
        runId: "run-1",
        currentNodeStartedAt: Date.now(),
      }),
    );

    const getScenario = vi.fn(async () => scenarioDefinitionFixture);

    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios,
      getScenarioStatus,
      getScenario,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();
    expect(container.textContent).toContain("Active scenarios");
    const settledCalls = listScenarios.mock.calls.length;

    // Force parent page re-renders via status events. CpDetailPage passes a
    // freshly-mapped connectorIds array on every render; the hook must key
    // its fetch effect on the array's content, not its identity, or each
    // re-render refetches (the loop this test pins down).
    for (const status of [
      OCPPStatus.Preparing,
      OCPPStatus.Charging,
      OCPPStatus.Finishing,
    ]) {
      await act(async () => {
        service.__handlers.subscribe
          .get("CP-1")
          ?.forEach((h) => h({ type: "status", status }));
      });
    }
    await flush();
    expect(listScenarios.mock.calls.length).toBe(settledCalls);

    // A scenario lifecycle event does retrigger exactly one debounced refresh.
    await act(async () => {
      service.__handlers.subscribe.get("CP-1")?.forEach((h) =>
        h({
          type: "scenario-completed",
          connectorId: 1,
          scenarioId: "s1",
          runId: "run-1",
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await flush();
    expect(listScenarios.mock.calls.length).toBe(settledCalls + 1);
  });
});
