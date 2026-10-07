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
import { LIBRARY_SCOPE } from "../../lib/scenarioLibrary";
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

  async function renderPage(path: string, { libraryCopy = false } = {}) {
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
      // With `libraryCopy`, connector 1 holds a copy of the Library's
      // `lib-fork`.
      listScenarioDefinitions: vi.fn(async (cpId: string, connector) =>
        cpId === LIBRARY_SCOPE
          ? libraryCopy
            ? [forkScenario({ id: "lib-fork" })]
            : []
          : connector === 1
            ? [
                forkScenario(
                  libraryCopy ? { libraryId: "lib-fork" } : undefined,
                ),
              ]
            : [],
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
    return { ...rendered, service };
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const buttonIn = (root: ParentNode, text: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    );

  async function clickEl(el: Element | undefined | null) {
    expect(el, "expected the element to click").toBeTruthy();
    await act(async () => (el as HTMLElement).click());
    await flush(10);
  }

  async function renameAndSave(saveLabel: RegExp) {
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    expect(name.value).toBe("Fork demo");
    await act(async () => setInputValue(name, "Renamed"));
    await clickEl(
      Array.from(panel.querySelectorAll("button")).find((b) =>
        saveLabel.test(b.textContent?.trim() ?? ""),
      ),
    );
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

  it("the scenario card's run name links to the run panel", async () => {
    const { container } = await renderPage("/cp/CP-A?connector=1");
    expect(document.querySelector(PANEL)).toBeNull();
    const link = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="scenario-run"] a',
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
        '[data-testid="scenario-run"] a',
      ),
    ).find((a) => a.textContent?.includes("Fork demo"))!;
    expect(link).toBeTruthy();
    await act(async () => link.click());
    await flush(10);
    expect(location?.pathname).toBe("/cp/CP-A");
    expect(location?.search).toBe("?connector=1&run=s1");
    expect(document.querySelector(PANEL)).toBeTruthy();
  });
  it("Edit scenario in the run panel edits the Library entry of a copy (&edit=1)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { service } = await renderPage("/cp/CP-A?connector=1&run=s1", {
      libraryCopy: true,
    });
    await clickEl(buttonIn(document.querySelector(PANEL)!, "Edit scenario"));
    expect(new URLSearchParams(location?.search).get("edit")).toBe("1");
    expect(new URLSearchParams(location?.search).get("run")).toBe("s1");
    expect(
      document
        .querySelector(`${PANEL} a[aria-label="Open in the Library editor"]`)
        ?.getAttribute("href"),
    ).toBe("/scenarios?tab=library&edit=lib-fork");

    await renameAndSave(/^Save/);

    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      expect.objectContaining({ id: "lib-fork", name: "Renamed" }),
    );
    vi.restoreAllMocks();
  });

  it("a scenario that is not a Library copy is edited in its own scope", async () => {
    const { service } = await renderPage("/cp/CP-A?connector=1&run=s1&edit=1");
    await renameAndSave(/^Save$/);
    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      "CP-A",
      1,
      expect.objectContaining({ id: "s1", name: "Renamed" }),
    );
    // Closing the panel drops the edit mode with it.
    await clickEl(
      document.querySelector(`${PANEL} button[aria-label="Close side panel"]`),
    );
    expect(location?.search).toBe("?connector=1");
  });

  it("the run page keeps Edit scenario as a link to the Library editor", async () => {
    await renderPage("/scenarios/run?cp=CP-A&connector=1&id=s1", {
      libraryCopy: true,
    });
    const edit = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit scenario"),
    );
    expect(edit?.getAttribute("href")).toBe(
      "/scenarios?tab=library&edit=lib-fork",
    );
    expect(buttonIn(document, "Edit scenario")).toBeUndefined();
  });
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

  const search = () => new URLSearchParams(location?.search ?? "");

  it("Esc in a clean editing run panel returns to the run, keeping the panel open", async () => {
    await renderPage("/cp/CP-A?connector=1&run=s1&edit=1");
    await pressEscape();
    expect(search().get("edit")).toBeNull();
    expect(search().get("run")).toBe("s1");
    const panel = document.querySelector(PANEL)!;
    expect(panel.querySelector('input[aria-label="Scenario name"]')).toBeNull();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
  });

  it("Esc with unsaved changes in the run panel asks first, like Cancel", async () => {
    await renderPage("/cp/CP-A?connector=1&run=s1&edit=1");
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Unsaved"));

    await pressEscape();
    const question = panel.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Discard unsaved changes?");
    expect(search().get("edit")).toBe("1");
    expect(search().get("run")).toBe("s1");

    await clickEl(buttonIn(question!, "Keep editing"));
    expect(name.value).toBe("Unsaved");
    expect(search().get("edit")).toBe("1");

    await pressEscape();
    await clickEl(
      buttonIn(panel.querySelector('[role="alertdialog"]')!, "Discard"),
    );
    expect(search().get("edit")).toBeNull();
    expect(search().get("run")).toBe("s1");
    expect(
      document.querySelector(PANEL)?.querySelector("h2")?.textContent,
    ).toBe("Fork demo");
  });
  it("the close button of a dirty editing run panel asks first; Discard closes the panel", async () => {
    await renderPage("/cp/CP-A?connector=1&run=s1&edit=1");
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Unsaved"));
    const closeButton = () =>
      panel.querySelector<HTMLButtonElement>(
        'button[aria-label="Close side panel"]',
      );

    await clickEl(closeButton());
    const question = panel.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Discard unsaved changes?");
    expect(search().get("run")).toBe("s1");
    await clickEl(buttonIn(question!, "Keep editing"));
    expect(name.value).toBe("Unsaved");
    expect(search().get("edit")).toBe("1");

    await clickEl(closeButton());
    await clickEl(
      buttonIn(panel.querySelector('[role="alertdialog"]')!, "Discard"),
    );
    expect(document.querySelector(PANEL)).toBeNull();
    expect(location?.search).toBe("?connector=1");
  });
});
