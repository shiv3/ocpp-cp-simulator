// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useAllScenarios } from "./useAllScenarios";
import { createFakeChargePointService } from "../test/harness";
import { DataContext } from "../../data/providers/DataProvider";
import type { ChargePointSnapshot } from "../../data/interfaces/ChargePointService";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

function connector(id: number): ChargePointSnapshot["connectors"][number] {
  return {
    id,
    status: "Available" as ChargePointSnapshot["connectors"][number]["status"],
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

function scenario(
  overrides: Partial<ScenarioDefinition> & { id: string },
): ScenarioDefinition {
  return {
    name: overrides.id,
    targetType: "chargePoint",
    nodes: [],
    edges: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface ProbeResult {
  items: ReturnType<typeof useAllScenarios>["items"];
  isLoading: boolean;
  error: string | null;
  refreshCount: number;
}

let latestProbeResult: ProbeResult | null = null;
let latestHookApi: ReturnType<typeof useAllScenarios> | null = null;

function Probe() {
  const api = useAllScenarios();
  latestHookApi = api;
  latestProbeResult = {
    items: api.items,
    isLoading: api.isLoading,
    error: api.error,
    refreshCount: 0,
  };
  return (
    <div>
      <div data-testid="loading">{String(api.isLoading)}</div>
      <div data-testid="count">{api.items.length}</div>
      <ul>
        {api.items.map((item) => (
          <li key={item.scenario.id}>
            {item.cpId}:{item.connectorId ?? "cp"}:{item.scenario.id}
          </li>
        ))}
      </ul>
    </div>
  );
}

async function renderProbe(
  service: ReturnType<typeof createFakeChargePointService>,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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
        <Probe />
      </DataContext.Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

describe("useAllScenarios", () => {
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
    latestProbeResult = null;
    latestHookApi = null;
  });

  it("enumerates chargePoint-scope and every connector-scope across all CPs, de-duping by scenario.id", async () => {
    const cp1 = snapshot({
      id: "CP-1",
      connectors: [connector(1), connector(2)],
    });
    const cp2 = snapshot({ id: "CP-2", connectors: [connector(1)] });

    const cpScopeScenario = scenario({ id: "s-cp1-scope", name: "CP-wide" });
    const connScopeScenario = scenario({
      id: "s-cp1-c1",
      name: "CP-1 connector 1 original",
      targetType: "connector",
      targetId: 1,
    });
    // Same id reused under CP-2/connector-1 to prove de-dupe keeps the
    // first-seen occurrence (CP-1 iterates before CP-2).
    const duplicateIdScenario = scenario({
      id: "s-cp1-c1",
      name: "CP-2 connector 1 duplicate id",
      targetType: "connector",
      targetId: 1,
    });
    const uniqueCp2Scenario = scenario({
      id: "s-cp2-c1",
      name: "CP-2 connector 1 unique",
      targetType: "connector",
      targetId: 1,
    });

    const byScope: Record<string, ScenarioDefinition[]> = {
      "CP-1:cp": [cpScopeScenario],
      "CP-1:1": [connScopeScenario],
      "CP-1:2": [],
      "CP-2:cp": [],
      "CP-2:1": [duplicateIdScenario, uniqueCp2Scenario],
    };

    const service = createFakeChargePointService({
      snapshots: [cp1, cp2],
      listScenarioDefinitions: vi.fn(
        async (cpId: string, connectorId: number | null) =>
          byScope[`${cpId}:${connectorId ?? "cp"}`] ?? [],
      ),
    });

    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);

    expect(latestProbeResult?.isLoading).toBe(false);
    expect(latestProbeResult?.items).toHaveLength(3);

    const ids = latestProbeResult!.items.map((i) => i.scenario.id).sort();
    expect(ids).toEqual(["s-cp1-c1", "s-cp1-scope", "s-cp2-c1"]);

    const deduped = latestProbeResult!.items.find(
      (i) => i.scenario.id === "s-cp1-c1",
    );
    expect(deduped?.cpId).toBe("CP-1");
    expect(deduped?.connectorId).toBe(1);
    expect(deduped?.scenario.name).toBe("CP-1 connector 1 original");

    const cpScopeItem = latestProbeResult!.items.find(
      (i) => i.scenario.id === "s-cp1-scope",
    );
    expect(cpScopeItem?.connectorId).toBeNull();
  });

  it("remove() calls deleteScenarioDefinition with the exact (cpId, connectorId, scenarioId) instead of read-filter-replace", async () => {
    // Regression for the TOCTOU race: a whole-list replace here could
    // resurrect a concurrent delete of a *different* scenario in the same
    // scope, since both reads would happen before either write lands.
    const cp1 = snapshot({ id: "CP-1", connectors: [connector(1)] });
    const target = scenario({ id: "s-target", name: "To delete" });
    const sibling = scenario({ id: "s-sibling", name: "Keep me" });

    const byScope: Record<string, ScenarioDefinition[]> = {
      "CP-1:cp": [],
      "CP-1:1": [target, sibling],
    };

    const service = createFakeChargePointService({
      snapshots: [cp1],
      listScenarioDefinitions: vi.fn(
        async (cpId: string, connectorId: number | null) =>
          byScope[`${cpId}:${connectorId ?? "cp"}`] ?? [],
      ),
    });

    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);

    expect(latestProbeResult?.items).toHaveLength(2);

    // Simulate the atomic delete taking effect server-side, so the
    // follow-up refresh() sees the post-delete state.
    byScope["CP-1:1"] = [sibling];

    await act(async () => {
      await latestHookApi!.remove("CP-1", 1, "s-target");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(service.deleteScenarioDefinition).toHaveBeenCalledWith(
      "CP-1",
      1,
      "s-target",
    );
    expect(service.replaceConnectorScenarioDefinitions).not.toHaveBeenCalled();
    expect(latestProbeResult?.items).toHaveLength(1);
    expect(latestProbeResult?.items[0]?.scenario.id).toBe("s-sibling");
  });

  it("refresh() catches a load failure, exposes it via error, and doesn't wipe existing items", async () => {
    const service = createFakeChargePointService({
      listChargePoints: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);

    expect(latestProbeResult?.isLoading).toBe(false);
    expect(latestProbeResult?.error).toBe("network down");
    expect(latestProbeResult?.items).toHaveLength(0);
  });

  it("save() persists via saveScenarioDefinition and refreshes items", async () => {
    const cp1 = snapshot({ id: "CP-1", connectors: [] });
    const byScope: Record<string, ScenarioDefinition[]> = {
      "CP-1:cp": [],
    };

    const service = createFakeChargePointService({
      snapshots: [cp1],
      listScenarioDefinitions: vi.fn(
        async (cpId: string, connectorId: number | null) =>
          byScope[`${cpId}:${connectorId ?? "cp"}`] ?? [],
      ),
    });

    const { root } = await renderProbe(service);
    cleanup = () => unmount(root);

    expect(latestProbeResult?.items).toHaveLength(0);

    const newScenario = scenario({ id: "s-new", name: "Brand new" });
    byScope["CP-1:cp"] = [newScenario];

    await act(async () => {
      await latestHookApi!.save("CP-1", null, newScenario);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      "CP-1",
      null,
      newScenario,
    );
    expect(latestProbeResult?.items).toHaveLength(1);
    expect(latestProbeResult?.items[0]?.scenario.id).toBe("s-new");
  });
});
