// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useAllActiveScenarioRuns } from "./useAllActiveScenarioRuns";
import { createFakeChargePointService, pushEvent } from "../test/harness";
import { DataContext } from "../../data/providers/DataProvider";
import type { ChargePointSnapshot } from "../../data/interfaces/ChargePointService";
import type { ScenarioExecutionContext } from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

function connector(id: number): ChargePointSnapshot["connectors"][number] {
  return {
    id,
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
  };
}

function snapshot(id: string): ChargePointSnapshot {
  return {
    id,
    status: OCPPStatus.Available,
    error: "",
    connectors: [connector(1)],
  };
}

const CP_A = snapshot("CP-A");
const CP_B = snapshot("CP-B");

let latest: ReturnType<typeof useAllActiveScenarioRuns> | null = null;

function Probe({ chargePoints }: { chargePoints: ChargePointSnapshot[] }) {
  latest = useAllActiveScenarioRuns(chargePoints);
  return (
    <ul>
      {latest.runs.map((run) => (
        <li key={`${run.cpId}:${run.connectorId}:${run.scenarioId}`}>
          {run.cpId}:{run.name}:{run.state}
        </li>
      ))}
    </ul>
  );
}

function wrap(
  service: ReturnType<typeof createFakeChargePointService>,
  chargePoints: ChargePointSnapshot[],
) {
  return (
    <DataContext.Provider
      value={{
        mode: "remote",
        serverUrl: "http://test",
        defaultEvSettings: null,
        setDefaultEvSettings: () => {},
        chargePointService: service,
      }}
    >
      <Probe chargePoints={chargePoints} />
    </DataContext.Provider>
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Waits out the hook's re-query debounce (200 ms). */
async function waitForDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await settle();
}

describe("useAllActiveScenarioRuns", () => {
  let root: Root | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => {
        current.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
    latest = null;
  });

  function makeService() {
    const states: Record<string, ScenarioExecutionContext["state"]> = {
      "CP-A": "running",
      "CP-B": "waiting",
    };
    const getScenarioStatus = vi.fn(
      async (
        cpId: string,
        _connectorId: number,
        scenarioId: string,
      ): Promise<ScenarioExecutionContext | null> => ({
        scenarioId,
        state: states[cpId],
        mode: "oneshot",
        currentNodeId: null,
        executedNodes: [],
        loopCount: 0,
        runId: `run-${cpId}`,
      }),
    );
    const service = createFakeChargePointService({
      snapshots: [CP_A, CP_B],
      listScenarios: vi.fn(async (cpId: string) => [
        {
          scenarioId: `s-${cpId}`,
          name: cpId === "CP-A" ? "Alpha" : "Beta",
          active: true,
        },
      ]),
      getScenarioStatus,
      getScenario: vi.fn(async () => null),
    });
    return { service, states, getScenarioStatus };
  }

  async function mount(
    service: ReturnType<typeof createFakeChargePointService>,
    chargePoints: ChargePointSnapshot[],
  ) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(wrap(service, chargePoints));
    });
    await settle();
    return container;
  }

  it("returns the runs of every charge point, each tagged with its cpId", async () => {
    const { service } = makeService();
    await mount(service, [CP_A, CP_B]);

    expect(latest!.isLoading).toBe(false);
    expect(
      latest!.runs.map((r) => `${r.cpId}:${r.name}:${r.state}`).sort(),
    ).toEqual(["CP-A:Alpha:running", "CP-B:Beta:waiting"]);
    expect(latest!.runs.find((r) => r.cpId === "CP-B")?.runId).toBe("run-CP-B");
  });

  it("re-fetches on a scenario-completed event of CP-B and drops its run", async () => {
    const { service, states, getScenarioStatus } = makeService();
    await mount(service, [CP_A, CP_B]);
    const callsBefore = getScenarioStatus.mock.calls.length;

    states["CP-B"] = "completed";
    await pushEvent(service, "CP-B", {
      type: "scenario-completed",
      connectorId: 1,
      scenarioId: "s-CP-B",
    });
    await waitForDebounce();

    expect(getScenarioStatus.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(latest!.runs.map((r) => r.cpId)).toEqual(["CP-A"]);
  });

  it("drops the runs of a charge point that leaves the list", async () => {
    const { service } = makeService();
    await mount(service, [CP_A, CP_B]);
    expect(latest!.runs).toHaveLength(2);

    await act(async () => {
      root!.render(wrap(service, [CP_A]));
    });
    await settle();

    expect(latest!.runs.map((r) => r.cpId)).toEqual(["CP-A"]);
    // The removed charge point's subscription is released.
    expect(service.__handlers.subscribe.get("CP-B")?.size ?? 0).toBe(0);
  });

  it("refresh() re-reads the runs on demand", async () => {
    const { service, states } = makeService();
    await mount(service, [CP_A, CP_B]);

    states["CP-A"] = "paused";
    await act(async () => {
      await latest!.refresh();
    });

    expect(latest!.runs.find((r) => r.cpId === "CP-A")?.state).toBe("paused");
  });
});
