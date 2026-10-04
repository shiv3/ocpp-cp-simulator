// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
  type ReportedLocation,
} from "../../test/harness";
import { forkScenario } from "../../test/scenarioFixtures";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type { ScenarioExecutionContext } from "../../../cp/application/scenario/ScenarioTypes";

const cp: ChargePointSnapshot = {
  id: "CP-A",
  status: OCPPStatus.Available,
  error: "",
  connectors: [
    {
      id: 1,
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
    },
  ],
};

const PANEL = 'aside[aria-label="Scenario run"]';

describe("Charge point page — scenario run panel", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let location: ReportedLocation | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    location = null;
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function renderPage(path: string) {
    const status: ScenarioExecutionContext = {
      scenarioId: "s1",
      state: "running",
      mode: "oneshot",
      currentNodeId: "status",
      executedNodes: ["plug", "status"],
      loopCount: 0,
      runId: "run-7",
      currentNodeStartedAt: Date.now() - 3000,
    };
    const service = createFakeChargePointService({
      snapshots: [cp],
      listScenarios: vi.fn(async () => [
        { scenarioId: "s1", name: "Fork demo", active: true },
      ]),
      getScenarioStatus: vi.fn(async () => status),
      getScenario: vi.fn(async () => forkScenario()),
      listScenarioDefinitions: vi.fn(async (_cp: string, connector) =>
        connector === 1 ? [forkScenario()] : [],
      ),
      getStateHistory: vi.fn(async () => []),
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
    return rendered;
  }

  it("?run= opens the run panel beside the page; expand goes to the run page", async () => {
    await renderPage("/cp/CP-A?connector=1&run=s1");
    const panel = document.querySelector(PANEL)!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
    expect(panel.textContent).toContain("CP-A #1");
    expect(
      panel
        .querySelector('[data-step-id="status"]')
        ?.getAttribute("data-phase"),
    ).toBe("current");

    const expand = panel.querySelector<HTMLAnchorElement>(
      'a[aria-label="Open the run as a full page"]',
    )!;
    expect(expand.getAttribute("href")).toBe(
      "/scenarios/run?cp=CP-A&connector=1&id=s1&run=run-7",
    );

    await act(async () => expand.click());
    await flush(10);
    expect(location?.pathname).toBe("/scenarios/run");
    // Back from the run page returns to the charge point with the panel.
    const back = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "← Back",
    );
    expect(back?.getAttribute("href")).toBe("/cp/CP-A?connector=1&run=s1");
  });

  it("the connector run row's scenario name links to the run panel", async () => {
    const { container } = await renderPage("/cp/CP-A?connector=1");
    expect(document.querySelector(PANEL)).toBeNull();
    const link = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="connector-run-row"] a',
      ),
    ).find((a) => a.textContent?.includes("Fork demo"))!;
    expect(link.getAttribute("href")).toBe("/cp/CP-A?connector=1&run=s1");

    await act(async () => link.click());
    await flush(10);
    expect(document.querySelector(PANEL)).toBeTruthy();
  });

  it("closing the panel removes ?run= and keeps the connector", async () => {
    await renderPage("/cp/CP-A?connector=1&run=s1");
    const close = document.querySelector<HTMLButtonElement>(
      `${PANEL} button[aria-label="Close side panel"]`,
    )!;
    await act(async () => close.click());
    await flush();
    expect(location?.search).toBe("?connector=1");
    expect(location?.type).toBe("REPLACE");
    expect(document.querySelector(PANEL)).toBeNull();
  });

  it("from the list's charge point panel, the run link opens the full page", async () => {
    const { container } = await renderPage("/?cp=CP-A&connector=1");
    const link = Array.from(
      container.ownerDocument.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="connector-run-row"] a',
      ),
    ).find((a) => a.textContent?.includes("Fork demo"))!;
    expect(link).toBeTruthy();
    await act(async () => link.click());
    await flush(10);
    expect(location?.pathname).toBe("/cp/CP-A");
    expect(location?.search).toBe("?connector=1&run=s1");
    expect(document.querySelector(PANEL)).toBeTruthy();
  });
});
