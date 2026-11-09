// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type ReportedLocation,
} from "../../test/harness";
import { createScenarioStore } from "../../test/scenarioStore";
import { LIBRARY_SCOPE, libraryCopyId } from "../../lib/scenarioLibrary";
import { createEmptyScenario } from "../../lib/scenarioSteps";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ChargePointSnapshot } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";

const CP1: ChargePointSnapshot = {
  id: "CP-1",
  status: OCPPStatus.Available,
  error: "",
  connectors: [1, 2].map((id) => ({
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
  })),
};

const PANEL = 'aside[aria-label="Scenario run"]';
const COPY_ID = libraryCopyId("lib-a", "CP-1", 1);

function lib(id: string, name: string): ScenarioDefinition {
  return { ...createEmptyScenario(name, "connector"), id };
}

describe("Connector scenario card: the scenario side panel", () => {
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

  async function renderAt(
    path: string,
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
  ) {
    const store = createScenarioStore();
    const a = lib("lib-a", "Charge flow");
    store.set(LIBRARY_SCOPE, null, [a]);
    store.set("CP-1", 1, [
      { ...a, id: COPY_ID, libraryId: "lib-a", targetId: 1 },
    ]);
    const service = createFakeChargePointService({
      snapshots: [CP1],
      ...store.methods,
      listScenarios: vi.fn(async () => []),
      getStateHistory: vi.fn(async () => []),
      runScenario: vi.fn(async () => undefined),
      ...overrides,
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
    await flush(10);
    return { ...rendered, service };
  }

  const buttonIn = (root: ParentNode, text: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === text,
    );
  const search = () => new URLSearchParams(location?.search ?? "");

  async function click(el: Element | undefined | null) {
    expect(el, "expected the element to click").toBeTruthy();
    await act(async () => (el as HTMLElement).click());
    await flush(10);
  }

  async function pressEscape() {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush(10);
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("the scenario's name opens the panel without a run: shareable URL, wide panel, 'no runs yet'", async () => {
    const { container } = await renderAt("/cp/CP-1?connector=1");
    expect(document.querySelector(PANEL)).toBeNull();
    const card = container.querySelector<HTMLElement>(
      '[data-testid="scenario-card"]',
    )!;

    await click(buttonIn(card, "Charge flow"));

    expect(search().get("connector")).toBe("1");
    expect(search().get("run")).toBe(COPY_ID);
    expect(search().get("edit")).toBeNull();
    expect(location?.type).toBe("PUSH");
    const panel = document.querySelector<HTMLElement>(PANEL)!;
    expect(panel.querySelector("h2")?.textContent).toBe("Charge flow");
    expect(panel.textContent).toContain("CP-1 #1");
    expect(buttonIn(panel, "Start")).toBeTruthy();
    expect(buttonIn(panel, "Stop")).toBeUndefined();
    expect(panel.textContent).toContain("Idle");
    expect(panel.textContent).toContain("Run history");
    expect(
      panel.querySelector('a[href="/scenarios?tab=library&edit=lib-a"]'),
    ).toBeTruthy();
    // Opens wide, for the Graph.
    expect(panel.style.getPropertyValue("--console-panel-width")).toBe(
      "min(960px, 70vw)",
    );
    // The Open button does the same as the name.
    await pressEscape();
    expect(document.querySelector(PANEL)).toBeNull();
    await click(buttonIn(card, "Open"));
    expect(search().get("run")).toBe(COPY_ID);
  });

  it("Start in the panel runs the scenario on the connector", async () => {
    const { service } = await renderAt(
      `/cp/CP-1?connector=1&run=${encodeURIComponent(COPY_ID)}`,
    );
    await click(buttonIn(document.querySelector(PANEL)!, "Start"));
    expect(service.loadScenario).toHaveBeenCalledWith(
      "CP-1",
      1,
      expect.objectContaining({ id: COPY_ID }),
    );
  });

  it("a live run shows its state in the panel, with Stop and the current step", async () => {
    await renderAt(`/cp/CP-1?connector=1&run=${encodeURIComponent(COPY_ID)}`, {
      listScenarios: vi.fn(async (_cp: string, connectorId: number) =>
        connectorId === 1
          ? [{ scenarioId: COPY_ID, name: "Charge flow", active: true }]
          : [],
      ),
      getScenarioStatus: vi.fn(async () => ({
        scenarioId: COPY_ID,
        state: "running" as const,
        mode: "oneshot" as const,
        currentNodeId: null,
        executedNodes: [],
        loopCount: 0,
        runId: "run-1",
        currentNodeStartedAt: Date.now(),
      })),
    });
    const panel = document.querySelector(PANEL)!;
    expect(buttonIn(panel, "Stop")).toBeTruthy();
    expect(buttonIn(panel, "Start")).toBeUndefined();
    expect(panel.textContent).toContain("Running");
  });

  it("Edit opens the panel in the editor (&edit=1); Save updates the Library; Esc leaves the editor, then closes", async () => {
    const { container, service } = await renderAt("/cp/CP-1?connector=1");
    const card = container.querySelector<HTMLElement>(
      '[data-testid="scenario-card"]',
    )!;

    await click(buttonIn(card, "Edit"));
    expect(search().get("run")).toBe(COPY_ID);
    expect(search().get("edit")).toBe("1");
    expect(buttonIn(card, "Edit in Library")).toBeUndefined();
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    expect(name.value).toBe("Charge flow");

    await act(async () => setInputValue(name, "Renamed"));
    await click(
      Array.from(panel.querySelectorAll("button")).find((b) =>
        /^Save/.test(b.textContent?.trim() ?? ""),
      ),
    );
    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      expect.objectContaining({ id: "lib-a", name: "Renamed" }),
    );

    // Esc in a clean editor is its Cancel: back to the read view, panel open.
    await pressEscape();
    expect(search().get("edit")).toBeNull();
    expect(search().get("run")).toBe(COPY_ID);
    expect(document.querySelector(PANEL)).toBeTruthy();
    // Esc in the read view closes the panel and keeps the connector.
    await pressEscape();
    expect(document.querySelector(PANEL)).toBeNull();
    expect(location?.search).toBe("?connector=1");
  });

  it("on the Charge Points list the scenario replaces the panel body, keeping ?cp=, ?connector= and the list's ?view=", async () => {
    const { container } = await renderAt("/?view=cp&cp=CP-1&connector=1");
    const card = container.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="scenario-card"]',
    )!;

    await click(buttonIn(card, "Edit"));
    expect(search().get("view")).toBe("cp");
    expect(search().get("cp")).toBe("CP-1");
    expect(search().get("connector")).toBe("1");
    expect(search().get("run")).toBe(COPY_ID);
    expect(search().get("edit")).toBe("1");
    expect(document.querySelectorAll(PANEL).length).toBe(1);
    expect(document.querySelector('[data-testid="scenario-card"]')).toBeNull();
    expect(
      document.querySelector('input[aria-label="Scenario name"]'),
    ).toBeTruthy();

    // Esc: editor -> read view -> charge point.
    await pressEscape();
    expect(search().get("edit")).toBeNull();
    expect(search().get("run")).toBe(COPY_ID);
    await pressEscape();
    expect(search().get("run")).toBeNull();
    expect(search().get("view")).toBe("cp");
    expect(search().get("cp")).toBe("CP-1");
    expect(
      document.querySelector('[data-testid="scenario-card"]'),
    ).toBeTruthy();
  });
});
