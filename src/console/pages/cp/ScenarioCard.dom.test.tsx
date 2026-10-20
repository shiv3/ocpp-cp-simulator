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

describe("ScenarioCard: the scenario on a connector", () => {
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

  it("without a live run, says so under a clear title, with Run as the primary action", async () => {
    const { container } = await renderCp();
    const card = container.querySelector<HTMLElement>(
      '[data-testid="scenario-card"]',
    )!;
    expect(card.querySelector("h3")?.textContent).toBe("No scenario running");
    expect(card.textContent).toContain(
      "Pick one from the Library to run on this connector.",
    );
    const run = button(card, "▶ Run")!;
    // The primary button style, not an outline.
    expect(run.className).toContain("bg-cx-primary");
  });

  it("with a live run, its name heads the card with Open run and Stop", async () => {
    const { container } = await renderCp(undefined, {
      listScenarios: vi.fn(async (_cp: string, connectorId: number) =>
        connectorId === 1
          ? [{ scenarioId: "lib-a@CP-1#1", name: "Charge flow", active: true }]
          : [],
      ),
      getScenarioStatus: vi.fn(async () => ({
        scenarioId: "lib-a@CP-1#1",
        state: "running" as const,
        mode: "oneshot" as const,
        currentNodeId: null,
        executedNodes: [],
        loopCount: 0,
        runId: "run-1",
        currentNodeStartedAt: Date.now(),
      })),
    });
    const card = container.querySelector<HTMLElement>(
      '[data-testid="scenario-card"]',
    )!;
    expect(card.querySelector("h3")?.textContent).toContain("Charge flow");
    expect(card.textContent).toContain("running");
    expect(card.textContent).not.toContain("No scenario running");
    expect(button(card, "Stop")).toBeTruthy();
    expect(
      Array.from(card.querySelectorAll("a")).some(
        (a) => a.textContent?.trim() === "Open run",
      ),
    ).toBe(true);
    // No picker while the run is live.
    expect(card.querySelector(SELECT)).toBeNull();
  });

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
      container.querySelector('[data-testid="scenario-card"] [role="status"]')
        ?.textContent,
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
      container.querySelector('[data-testid="scenario-card"] [role="alert"]'),
    ).toBeNull();
  });

  it("Use on all connectors assigns the scenario to every connector, confirming a replacement", async () => {
    const { container, service, b } = await renderCp((store) => {
      store.set("CP-1", 2, [copyOf(lib("lib-b", "Fault flow"), 2)]);
    });
    void b;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () =>
      button(container, "Use on all 2 connectors")!.click(),
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

  it("Edit in Library opens the scenario in the Library editor", async () => {
    const { container } = await renderCp();
    const gear = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Edit in Library",
    );
    expect(gear?.getAttribute("href")).toBe(
      "/scenarios?tab=library&edit=lib-a",
    );
  });
});
