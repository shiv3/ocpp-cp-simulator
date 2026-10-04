// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import { createScenarioStore } from "../../test/scenarioStore";
import { LIBRARY_SCOPE, libraryCopyId } from "../../lib/scenarioLibrary";
import { createEmptyScenario } from "../../lib/scenarioSteps";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

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

const CP1: ChargePointSnapshot = {
  id: "CP-1",
  status: OCPPStatus.Available,
  error: "",
  connectors: [connector(1), connector(2)],
};

function lib(id: string, name: string): ScenarioDefinition {
  return { ...createEmptyScenario(name, "connector"), id };
}

function copyOf(
  def: ScenarioDefinition,
  connectorId: number,
): ScenarioDefinition {
  return {
    ...def,
    id: libraryCopyId(def.id, "CP-1", connectorId),
    libraryId: def.id,
    targetId: connectorId,
  };
}

const SELECT = 'select[aria-label="Scenario for connector 1"]';

async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(10);
}

function button(root: ParentNode, text: string) {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.replace(/\s+/g, " ").trim() === text,
  );
}

describe("ConnectorRunRow — scenario selection", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function renderCp(
    setup: (store: ReturnType<typeof createScenarioStore>) => void = () => {},
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
  ) {
    const store = createScenarioStore();
    const a = lib("lib-a", "Charge flow");
    const b = lib("lib-b", "Fault flow");
    store.set(LIBRARY_SCOPE, null, [a, b]);
    store.set("CP-1", 1, [copyOf(a, 1)]);
    setup(store);
    const service = createFakeChargePointService({
      snapshots: [CP1],
      ...store.methods,
      listScenarios: vi.fn(async () => []),
      getStateHistory: vi.fn(async () => []),
      runScenario: vi.fn(async () => undefined),
      ...overrides,
    });
    const rendered = await renderConsole("/cp/CP-1", { service });
    cleanup = async () => {
      await act(async () => rendered.root.unmount());
      document.body.innerHTML = "";
    };
    await flush(10);
    return { ...rendered, service, store, a, b };
  }

  it("lists the library scenarios with None first and selects the connector's one", async () => {
    const { container } = await renderCp();
    const select = container.querySelector<HTMLSelectElement>(SELECT)!;
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "None",
      "Charge flow",
      "Fault flow",
    ]);
    expect(select.value).toBe("lib-a");
  });

  it("choosing a scenario assigns a tagged copy at once", async () => {
    const { container, service } = await renderCp();
    const select = container.querySelector<HTMLSelectElement>(SELECT)!;

    await change(select, "lib-b");

    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-1",
      1,
      [
        expect.objectContaining({
          id: libraryCopyId("lib-b", "CP-1", 1),
          libraryId: "lib-b",
          targetType: "connector",
          targetId: 1,
          name: "Fault flow",
        }),
      ],
    );
    expect(
      container.querySelector(
        '[data-testid="connector-scenario-select"] [role="status"]',
      )?.textContent,
    ).toContain("Scenario set");

    await change(select, "");
    expect(
      service.replaceConnectorScenarioDefinitions,
    ).toHaveBeenLastCalledWith("CP-1", 1, []);
    expect(button(container, "▶ Run")?.disabled).toBe(true);
  });

  it("Run starts the connector's copy", async () => {
    const { container, service } = await renderCp();

    await act(async () => button(container, "▶ Run")!.click());
    await flush(10);

    expect(service.runScenario).toHaveBeenCalledWith(
      "CP-1",
      1,
      libraryCopyId("lib-a", "CP-1", 1),
    );
  });

  it("Run loads the copy into the runtime when the runtime does not know it", async () => {
    let calls = 0;
    const runScenario = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Scenario lib-a@CP-1#1 not found");
    });
    const { container, service } = await renderCp(undefined, { runScenario });

    await act(async () => button(container, "▶ Run")!.click());
    await flush(10);

    expect(service.loadScenario).toHaveBeenCalledWith(
      "CP-1",
      1,
      expect.objectContaining({ id: libraryCopyId("lib-a", "CP-1", 1) }),
    );
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector(
        '[data-testid="connector-scenario-select"] [role="alert"]',
      ),
    ).toBeNull();
  });

  it("Apply to all connectors assigns the scenario to every connector, confirming a replacement", async () => {
    const { container, service, b } = await renderCp((store) => {
      store.set("CP-1", 2, [copyOf(lib("lib-b", "Fault flow"), 2)]);
    });
    void b;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () =>
      button(container, "Apply to all connectors")!.click(),
    );
    await flush(10);

    expect(confirm).toHaveBeenCalledWith(
      'Use "Charge flow" on every connector of CP-1? It replaces the scenario of connector 2.',
    );
    for (const connectorId of [1, 2]) {
      expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
        "CP-1",
        connectorId,
        [
          expect.objectContaining({
            id: libraryCopyId("lib-a", "CP-1", connectorId),
            libraryId: "lib-a",
            targetId: connectorId,
          }),
        ],
      );
    }
  });

  it("the gear opens the scenario in the Library editor", async () => {
    const { container } = await renderCp();
    const gear = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Edit scenario"]',
    );
    expect(gear?.getAttribute("href")).toBe(
      "/scenarios?tab=library&edit=lib-a",
    );
  });
});
