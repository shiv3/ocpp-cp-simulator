// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  findMenuItem,
  flush,
  openDropdownMenu,
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../../test/harness";
import {
  createScenarioStore,
  type ScenarioStore,
} from "../../test/scenarioStore";
import { LIBRARY_SCOPE, libraryCopyId } from "../../lib/scenarioLibrary";
import { createEmptyScenario, insertStep } from "../../lib/scenarioSteps";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioExecutionContext,
} from "../../../cp/application/scenario/ScenarioTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import { scenarioTemplates } from "../../../utils/scenarioTemplates";

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

function chargeFlow(): ScenarioDefinition {
  let def = createEmptyScenario("Charge flow", "connector");
  def = insertStep(def, 0, ScenarioNodeType.STATUS_CHANGE);
  def = insertStep(def, 1, ScenarioNodeType.DELAY);
  return { ...def, id: "lib-a", description: "Plug and charge" };
}

const COPY_ID = libraryCopyId("lib-a", "CP-1", 1);

function copyOnConnector1(): ScenarioDefinition {
  return {
    ...chargeFlow(),
    id: COPY_ID,
    libraryId: "lib-a",
    targetId: 1,
  };
}

function buttonByText(root: ParentNode, text: string) {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(el: Element | undefined | null) {
  expect(el, "expected the element to click").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(10);
}

describe("Scenario Library", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let location: ReportedLocation | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    location = null;
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function renderLibrary(
    path = "/scenarios?tab=library",
    {
      store = createScenarioStore(),
      running = false,
      pushRegistry = true,
      seed = true,
    }: {
      store?: ScenarioStore;
      running?: boolean;
      pushRegistry?: boolean;
      seed?: boolean;
    } = {},
  ) {
    if (seed) {
      store.set(LIBRARY_SCOPE, null, [chargeFlow()]);
      store.set("CP-1", 1, [copyOnConnector1()]);
    }
    const status: ScenarioExecutionContext = {
      scenarioId: COPY_ID,
      state: "running",
      mode: "oneshot",
      currentNodeId: null,
      executedNodes: [],
      loopCount: 0,
      runId: "run-1",
    };
    const service: FakeChargePointService = createFakeChargePointService({
      snapshots: [],
      ...store.methods,
      listScenarios: vi.fn(async (_cp: string, connectorId: number) =>
        running && connectorId === 1
          ? [{ scenarioId: COPY_ID, name: "Charge flow", active: true }]
          : [],
      ),
      getScenarioStatus: vi.fn(async () => (running ? status : null)),
      getScenario: vi.fn(async () => copyOnConnector1()),
    });
    const rendered = await renderConsole(path, {
      service,
      onLocationChange: (l) => {
        location = l;
      },
    });
    cleanup = async () => {
      await act(async () => rendered.root.unmount());
      document.body.innerHTML = "";
    };
    if (pushRegistry) await pushSnapshot(service);
    await flush(10);
    return { ...rendered, service, store };
  }

  async function pushSnapshot(service: FakeChargePointService) {
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [CP1] });
      }
    });
    await flush(10);
  }

  function search(): URLSearchParams {
    return new URLSearchParams(location?.search ?? "");
  }

  it("shows Scenario, Steps, Used by, Running, Enabled and Edit for each library scenario", async () => {
    const { container } = await renderLibrary(undefined, { running: true });

    const headers = Array.from(container.querySelectorAll("thead th")).map(
      (th) => th.textContent?.trim(),
    );
    expect(headers.slice(0, 6)).toEqual([
      "Scenario",
      "Steps",
      "Used by",
      "Running",
      "Enabled",
      "Edit",
    ]);

    const row = container.querySelector('[data-scenario-id="lib-a"]')!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Charge flow");
    expect(row.textContent).toContain("Plug and charge");
    expect(row.textContent).toContain("2 steps");
    expect(row.textContent).toContain("1 connector");
    expect(row.textContent).toContain("running");
    expect(
      row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
    ).toBe(true);
    expect(buttonByText(row, "Edit")).toBeTruthy();
    // The header counts library scenarios, not the connectors' copies.
    expect(container.textContent).toContain("1 total");
  });

  it("re-reads the connectors' copies when the charge point list arrives after mount", async () => {
    const { container, service } = await renderLibrary(undefined, {
      pushRegistry: false,
    });
    const row = () => container.querySelector('[data-scenario-id="lib-a"]')!;
    // The library itself does not wait for the charge points.
    expect(row()).toBeTruthy();
    expect(row().textContent).not.toContain("1 connector");

    await pushSnapshot(service);

    expect(row().textContent).toContain("1 connector");
  });

  it("Edit opens the inline editor (?edit=) with Used by and a Save that applies to the users", async () => {
    const { container } = await renderLibrary();

    await click(
      buttonByText(
        container.querySelector('[data-scenario-id="lib-a"]')!,
        "Edit",
      ),
    );

    expect(search().get("edit")).toBe("lib-a");
    expect(search().get("tab")).toBe("library");
    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    );
    expect(name?.value).toBe("Charge flow");
    expect(buttonByText(container, "← Library")).toBeTruthy();
    expect(
      buttonByText(container, "Save and apply to 1 connector"),
    ).toBeTruthy();
    const usedBy = container.querySelector('[data-testid="library-used-by"]');
    expect(usedBy?.textContent).toContain("CP-1 #1");
    // The table is replaced by the editor.
    expect(container.querySelector('[data-scenario-id="lib-a"]')).toBeNull();

    await click(buttonByText(container, "← Library"));
    expect(search().get("edit")).toBeNull();
  });

  it("Save writes the library scope and re-pushes the copy, confirming when a run would be stopped", async () => {
    const { container, service } = await renderLibrary(
      "/scenarios?tab=library&edit=lib-a",
      { running: true },
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Renamed flow"));
    await click(buttonByText(container, "Save and apply to 1 connector"));

    expect(confirm).toHaveBeenCalledWith(
      "A run of this scenario is active on 1 connector and will be stopped. Save?",
    );
    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      expect.objectContaining({ id: "lib-a", name: "Renamed flow" }),
    );
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-1",
      1,
      [
        expect.objectContaining({
          id: COPY_ID,
          libraryId: "lib-a",
          name: "Renamed flow",
          targetId: 1,
        }),
      ],
    );
  });

  it("the editor's Graph view is the card graph for a scenario it can draw", async () => {
    const { container } = await renderLibrary(
      "/scenarios?tab=library&edit=lib-a&view=graph",
    );
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(2);
    expect(container.querySelector(".react-flow__node")).toBeNull();
    expect(
      container.querySelector('button[aria-label="Add step after step 2"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('button[aria-label="Add a parallel branch"]'),
    ).toBeTruthy();
  });

  it("+ New scenario asks only for a name and creates a library scenario", async () => {
    const { container, service } = await renderLibrary();

    await click(buttonByText(container, "+ New scenario"));
    expect(document.body.querySelector("#new-scenario-cp")).toBeNull();
    const nameInput =
      document.body.querySelector<HTMLInputElement>("#new-scenario-name");
    expect(nameInput).toBeTruthy();
    await act(async () => setInputValue(nameInput!, "Fresh"));
    await click(buttonByText(document.body, "Create"));

    const call = vi
      .mocked(service.saveScenarioDefinition)
      .mock.calls.find(([cp]) => cp === LIBRARY_SCOPE);
    expect(call).toBeTruthy();
    expect(call![1]).toBeNull();
    expect(call![2]).toMatchObject({ name: "Fresh", targetType: "connector" });
    expect(call![2]).not.toHaveProperty("targetId");
    expect(search().get("edit")).toBe(call![2].id);
  });

  it("Use template creates a library scenario from the template", async () => {
    const { container, service } = await renderLibrary();

    await click(buttonByText(container, "Use template"));

    const call = vi
      .mocked(service.saveScenarioDefinition)
      .mock.calls.find(([cp]) => cp === LIBRARY_SCOPE);
    expect(call?.[2]).toMatchObject({
      templateId: scenarioTemplates[0].id,
      targetType: "connector",
    });
    expect(call?.[2]).not.toHaveProperty("targetId");
    expect(search().get("edit")).toBe(call?.[2].id);
  });

  it("browsing every template reaches one beyond the gallery's first eight", async () => {
    const { container, service } = await renderLibrary();
    expect(scenarioTemplates.length).toBeGreaterThan(8);
    const beyond = scenarioTemplates[scenarioTemplates.length - 1];

    await click(
      buttonByText(
        container,
        `Browse all ${scenarioTemplates.length} templates`,
      ),
    );
    const row = document.body.querySelector(
      `[role="dialog"] [data-template-id="${beyond.id}"]`,
    );
    expect(row, "the last template is listed in the browser").toBeTruthy();
    await click(buttonByText(row!, "Use template"));

    const call = vi
      .mocked(service.saveScenarioDefinition)
      .mock.calls.find(([cp]) => cp === LIBRARY_SCOPE);
    expect(call?.[2]).toMatchObject({
      templateId: beyond.id,
      targetType: beyond.targetType,
    });
    expect(search().get("edit")).toBe(call?.[2].id);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Delete names the users, un-assigns them, then deletes the library scenario", async () => {
    const { service, store } = await renderLibrary();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const trigger = document.body.querySelector(
      'button[aria-label="More actions for Charge flow"]',
    );
    await openDropdownMenu(trigger!);
    await click(findMenuItem("Delete"));

    expect(confirm).toHaveBeenCalledWith(
      'Delete "Charge flow"? It is used by CP-1 #1, which will be left without a scenario.',
    );
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-1",
      1,
      [],
    );
    expect(service.deleteScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      "lib-a",
    );
    expect(store.get(LIBRARY_SCOPE, null)).toEqual([]);
  });

  it("moves the connectors' definitions into an empty library once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const store = createScenarioStore();
    const legacy = { ...chargeFlow(), id: "legacy-1", targetId: 1 };
    store.set("CP-1", 1, [legacy]);

    const { container } = await renderLibrary(undefined, {
      store,
      seed: false,
    });
    await flush(10);

    const library = store.get(LIBRARY_SCOPE, null);
    expect(library).toHaveLength(1);
    expect(store.get("CP-1", 1)[0]).toMatchObject({
      id: "legacy-1",
      libraryId: library[0].id,
    });
    const row = container.querySelector(
      `[data-scenario-id="${library[0].id}"]`,
    );
    expect(row?.textContent).toContain("1 connector");
  });
});
