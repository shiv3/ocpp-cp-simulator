// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type ReportedLocation,
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
    connectors: [connector(1), connector(2)],
  };
}

interface RunFixture {
  cpId: string;
  connectorId: number;
  scenarioId: string;
  name: string;
  state: ScenarioExecutionContext["state"];
}

const RUNS: RunFixture[] = [
  {
    cpId: "CP-A",
    connectorId: 1,
    scenarioId: "s-alpha",
    name: "Alpha",
    state: "running",
  },
  {
    cpId: "CP-A",
    connectorId: 2,
    scenarioId: "s-beta",
    name: "Beta",
    state: "waiting",
  },
  {
    cpId: "CP-B",
    connectorId: 1,
    scenarioId: "s-gamma",
    name: "Gamma",
    state: "waiting",
  },
  {
    cpId: "CP-B",
    connectorId: 2,
    scenarioId: "s-delta",
    name: "Delta",
    state: "stepping",
  },
];

const DEFINITION: ScenarioDefinition = {
  id: "x",
  name: "x",
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
      type: "delay",
      data: { label: "Settle" },
      position: { x: 0, y: 1 },
    },
    {
      id: "n3",
      type: "delay",
      data: { label: "Done" },
      position: { x: 0, y: 2 },
    },
  ],
  edges: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function rowKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-run-key]")).map(
    (el) => el.getAttribute("data-run-key") ?? "",
  );
}

function tile(container: HTMLElement, state: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="Run state"] [data-state="${state}"]`,
  );
  expect(el, `expected the ${state} tile`).toBeTruthy();
  return el!;
}

function buttonIn(row: Element, label: string): HTMLButtonElement | undefined {
  return Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
}

describe("Scenarios page — Active runs tab", () => {
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

  async function renderPage(
    path: string,
    runs: RunFixture[] = RUNS,
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
  ) {
    const service = createFakeChargePointService({
      snapshots: [snapshot("CP-A"), snapshot("CP-B")],
      listScenarios: vi.fn(async (cpId: string, connectorId: number) =>
        runs
          .filter((r) => r.cpId === cpId && r.connectorId === connectorId)
          .map((r) => ({
            scenarioId: r.scenarioId,
            name: r.name,
            active: true,
          })),
      ),
      getScenarioStatus: vi.fn(
        async (
          cpId: string,
          connectorId: number,
          scenarioId: string,
        ): Promise<ScenarioExecutionContext | null> => {
          const run = runs.find(
            (r) =>
              r.cpId === cpId &&
              r.connectorId === connectorId &&
              r.scenarioId === scenarioId,
          );
          if (!run) return null;
          return {
            scenarioId,
            state: run.state,
            mode: "oneshot",
            currentNodeId: "n2",
            executedNodes: ["n1"],
            loopCount: 0,
            runId: `run-${scenarioId}`,
            currentNodeStartedAt: Date.now() - 5000,
          };
        },
      ),
      getScenario: vi.fn(async () => DEFINITION),
      listScenarioDefinitions: vi.fn(async () => []),
      ...overrides,
    });
    const rendered = await renderConsole(path, {
      service,
      onLocationChange: (l) => {
        location = l;
      },
    });
    cleanup = () => unmount(rendered.root);
    // Remote mode fills the charge point list from registry events only;
    // push the snapshot the daemon sends on subscribe.
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({
          type: "snapshot",
          cps: [snapshot("CP-A"), snapshot("CP-B")],
        });
      }
      await Promise.resolve();
    });
    await flush(8);
    return { ...rendered, service };
  }

  it("opens on Active runs and shows one row per run with its charge point, connector and step", async () => {
    const { container } = await renderPage("/scenarios");

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(Array.from(tabs).map((t) => t.textContent?.trim())).toEqual([
      "Active runs",
      "Library",
    ]);
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe("Active runs");

    expect(rowKeys(container).sort()).toEqual([
      "CP-A:1:s-alpha",
      "CP-A:2:s-beta",
      "CP-B:1:s-gamma",
      "CP-B:2:s-delta",
    ]);
    const alpha = container.querySelector('[data-run-key="CP-A:1:s-alpha"]')!;
    expect(alpha.textContent).toContain("Alpha");
    expect(alpha.textContent).toContain("CP-A #1");
    // Current step label, then k/N.
    expect(alpha.textContent).toContain("Settle");
    expect(alpha.textContent).toContain("1/3");
    // No Library content on this tab.
    expect(container.querySelector("table")).toBeNull();
  });

  it("tiles count every run by state", async () => {
    const { container } = await renderPage("/scenarios");

    const counts = Object.fromEntries(
      ["all", "running", "waiting", "paused", "stepping"].map((s) => [
        s,
        tile(container, s).textContent,
      ]),
    );
    expect(counts.all).toContain("4");
    expect(counts.running).toContain("1");
    expect(counts.waiting).toContain("2");
    expect(counts.paused).toContain("0");
    expect(counts.stepping).toContain("1");
    expect(tile(container, "all").getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the waiting tile filters the rows and sets ?state=waiting; All clears it", async () => {
    const { container } = await renderPage("/scenarios");

    await act(async () => {
      tile(container, "waiting").click();
    });

    expect(location?.search).toBe("?state=waiting");
    expect(rowKeys(container).sort()).toEqual([
      "CP-A:2:s-beta",
      "CP-B:1:s-gamma",
    ]);
    expect(tile(container, "waiting").getAttribute("aria-pressed")).toBe(
      "true",
    );
    // The counts stay those of all runs.
    expect(tile(container, "all").textContent).toContain("4");
    expect(container.textContent).toContain("2 / 4");

    await act(async () => {
      tile(container, "all").click();
    });
    expect(location?.search).toBe("");
    expect(rowKeys(container)).toHaveLength(4);
  });

  it("the charge point combobox filters by substring and sets ?cp=", async () => {
    const { container } = await renderPage("/scenarios");

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Charge point"]',
    )!;
    await act(async () => {
      setInputValue(input, "CP-B");
    });

    expect(location?.search).toBe("?cp=CP-B");
    expect(rowKeys(container).sort()).toEqual([
      "CP-B:1:s-gamma",
      "CP-B:2:s-delta",
    ]);
    expect(container.textContent).toContain("2 / 4");
  });

  it("the scenario combobox filters by name substring and sets ?q=", async () => {
    const { container } = await renderPage("/scenarios");

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario"]',
    )!;
    await act(async () => {
      setInputValue(input, "amm");
    });

    expect(location?.search).toBe("?q=amm");
    expect(rowKeys(container)).toEqual(["CP-B:1:s-gamma"]);
  });

  it("reads ?state=, ?cp= and ?q= from the URL", async () => {
    const { container } = await renderPage("/scenarios?state=waiting&cp=CP-A");

    expect(rowKeys(container)).toEqual(["CP-A:2:s-beta"]);
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Charge point"]',
      )?.value,
    ).toBe("CP-A");
  });

  it("Stop calls stopScenario(cpId, connectorId, scenarioId) and re-reads the runs", async () => {
    const { container, service } = await renderPage("/scenarios");
    const statusCalls = (service.getScenarioStatus as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    const row = container.querySelector('[data-run-key="CP-B:1:s-gamma"]')!;
    await act(async () => {
      buttonIn(row, "Stop")!.click();
    });
    await flush();

    expect(service.stopScenario).toHaveBeenCalledWith("CP-B", 1, "s-gamma");
    expect(
      (service.getScenarioStatus as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(statusCalls);
  });

  it("Skip (waiting) calls continueScenarioWait; Next (stepping) calls stepScenario; other states have neither", async () => {
    const { container, service } = await renderPage("/scenarios");

    const waiting = container.querySelector('[data-run-key="CP-A:2:s-beta"]')!;
    expect(buttonIn(waiting, "Next")).toBeUndefined();
    await act(async () => {
      buttonIn(waiting, "Skip")!.click();
    });
    await flush();
    expect(service.continueScenarioWait).toHaveBeenCalledWith(
      "CP-A",
      2,
      "s-beta",
    );

    const stepping = container.querySelector(
      '[data-run-key="CP-B:2:s-delta"]',
    )!;
    expect(buttonIn(stepping, "Skip")).toBeUndefined();
    await act(async () => {
      buttonIn(stepping, "Next")!.click();
    });
    await flush();
    expect(service.stepScenario).toHaveBeenCalledWith("CP-B", 2, "s-delta");

    const running = container.querySelector('[data-run-key="CP-A:1:s-alpha"]')!;
    expect(buttonIn(running, "Skip")).toBeUndefined();
    expect(buttonIn(running, "Next")).toBeUndefined();
    expect(buttonIn(running, "Stop")).toBeTruthy();
  });

  it("a failed action is logged and shown inline under the row", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await renderPage("/scenarios", RUNS, {
      stopScenario: vi.fn(async () => {
        throw new Error("daemon said no");
      }),
    });

    const row = container.querySelector('[data-run-key="CP-A:1:s-alpha"]')!;
    await act(async () => {
      buttonIn(row, "Stop")!.click();
    });
    await flush();

    expect(errorSpy).toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("daemon said no");
  });

  it("says no scenario is running when there are no runs at all", async () => {
    const { container } = await renderPage("/scenarios", []);

    expect(container.textContent).toContain("No scenario is running.");
    expect(container.textContent).not.toContain("No active run matches");
  });

  it("says no run matches when the filters leave nothing", async () => {
    const { container } = await renderPage("/scenarios?cp=CP-ZZZ");

    expect(container.textContent).toContain(
      "No active run matches the current filters.",
    );
    expect(container.textContent).not.toContain("No scenario is running.");
  });

  it("?tab=library renders the template gallery and the library table", async () => {
    const demo: ScenarioDefinition = {
      ...DEFINITION,
      id: "s-lib",
      name: "Library demo",
      targetType: "chargePoint",
      targetId: undefined,
    };
    const { container } = await renderPage("/scenarios?tab=library", RUNS, {
      listScenarioDefinitions: vi.fn(async (_cpId: string, connectorId) =>
        connectorId === null ? [demo] : [],
      ),
    });

    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe("Library");
    expect(container.textContent).toContain("Templates");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.textContent).toContain("Library demo");
    expect(container.querySelector("[data-run-key]")).toBeNull();
  });

  it("switching tabs sets ?tab=library and keeps the other parameters; Active runs drops it", async () => {
    const { container } = await renderPage("/scenarios?cp=CP-A");

    const libraryTab = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((t) => t.textContent === "Library")!;
    await act(async () => {
      libraryTab.click();
    });
    expect(location?.search).toBe("?cp=CP-A&tab=library");

    const activeTab = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((t) => t.textContent === "Active runs")!;
    await act(async () => {
      activeTab.click();
    });
    expect(location?.search).toBe("?cp=CP-A");
  });
});
