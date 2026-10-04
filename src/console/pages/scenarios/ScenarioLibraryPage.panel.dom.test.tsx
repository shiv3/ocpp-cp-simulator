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

function snapshot(id: string): ChargePointSnapshot {
  return {
    id,
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
}

const RUN_ROW = '[data-run-key="CP-A:1:s1"]';
const LIBRARY_ROW = '[data-scenario-id="lib-fork"]';
const PANEL = 'aside[aria-label="Scenario"]';

function openParam(location: ReportedLocation | null): string | null {
  return new URLSearchParams(location?.search ?? "").get("open");
}

function editParam(location: ReportedLocation | null): string | null {
  return new URLSearchParams(location?.search ?? "").get("edit");
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const DEF_PATH = `/scenarios?tab=library&open=${encodeURIComponent(
  `def:${LIBRARY_SCOPE}/cp/lib-fork`,
)}`;

function buttonIn(root: Element, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
}

describe("Scenarios page — side panel", () => {
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
      snapshots: [snapshot("CP-A")],
      listScenarios: vi.fn(async () => [
        { scenarioId: "s1", name: "Fork demo", active: true },
      ]),
      getScenarioStatus: vi.fn(async () => status),
      getScenario: vi.fn(async () => forkScenario()),
      // The Library holds the scenario; connector 1 holds its copy, `s1`.
      listScenarioDefinitions: vi.fn(async (cp: string, connector) =>
        cp === LIBRARY_SCOPE
          ? [forkScenario({ id: "lib-fork" })]
          : connector === 1
            ? [forkScenario({ libraryId: "lib-fork" })]
            : [],
      ),
      stopScenario: vi.fn(async () => undefined),
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
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [snapshot("CP-A")] });
      }
      await Promise.resolve();
    });
    await flush(10);
    return { ...rendered, service };
  }

  async function click(el: Element) {
    await act(async () => {
      (el as HTMLElement).click();
    });
    await flush(10);
  }

  it("a click on an active run row opens the run panel (?open=run:…) with its name and Stop", async () => {
    const { container } = await renderPage("/scenarios");
    const row = container.querySelector(RUN_ROW)!;
    expect(row).toBeTruthy();
    expect(document.querySelector(PANEL)).toBeNull();

    await click(row.querySelector(".truncate")!);

    expect(openParam(location)).toBe("run:CP-A/1/s1");
    expect(location?.type).toBe("PUSH");
    const panel = document.querySelector(PANEL)!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
    expect(panel.textContent).toContain("CP-A #1");
    expect(buttonIn(panel, "Stop")).toBeTruthy();
    expect(
      container.querySelector(RUN_ROW)?.getAttribute("data-selected"),
    ).toBe("true");
    // The panel draws the run's steps.
    expect(panel.querySelectorAll("[data-step-id]")).toHaveLength(5);
    // Clicking the open row again closes it.
    await click(container.querySelector(`${RUN_ROW} .truncate`)!);
    expect(openParam(location)).toBeNull();
  });

  it("a row's own Stop button does not open the panel", async () => {
    const { container, service } = await renderPage("/scenarios");
    await click(buttonIn(container.querySelector(RUN_ROW)!, "Stop")!);
    expect(service.stopScenario).toHaveBeenCalledWith("CP-A", 1, "s1");
    expect(openParam(location)).toBeNull();
  });

  it("a click on a library row opens the definition panel with Used by and Edit scenario", async () => {
    const { container } = await renderPage("/scenarios?tab=library");
    const row = container.querySelector(LIBRARY_ROW)!;
    expect(row).toBeTruthy();

    await click(row.querySelector("td")!);

    expect(openParam(location)).toBe(`def:${LIBRARY_SCOPE}/cp/lib-fork`);
    const panel = document.querySelector(PANEL)!;
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
    expect(panel.textContent).toContain("Library");
    expect(panel.textContent).toContain("5 steps · 2 branches");
    expect(panel.textContent).toContain("Used by");
    // The assigned connector, marked with its live run.
    const chip = Array.from(panel.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "CP-A #1",
    );
    expect(chip?.getAttribute("href")).toBe("/cp/CP-A?connector=1");
    expect(chip?.getAttribute("data-running")).toBe("true");
    // Edit scenario edits in the panel (see below), not a link away.
    expect(buttonIn(panel, "Edit scenario")).toBeTruthy();
    // Plain steps, no run phase.
    expect(
      panel.querySelector('[data-step-id="plug"]')?.getAttribute("data-phase"),
    ).toBe("plain");
    expect(row.getAttribute("data-selected")).toBe("true");
    // The tab and the filters stay.
    expect(new URLSearchParams(location?.search).get("tab")).toBe("library");
  });

  it("Esc closes the panel and keeps the other parameters", async () => {
    await renderPage("/scenarios?tab=library&open=def:CP-A/1/s1");
    expect(document.querySelector(PANEL)).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await flush();

    expect(openParam(location)).toBeNull();
    expect(location?.type).toBe("REPLACE");
    expect(new URLSearchParams(location?.search).get("tab")).toBe("library");
    expect(document.querySelector(PANEL)).toBeNull();
  });

  it("?open= on load opens the panel; a click on the page background closes it", async () => {
    const { container } = await renderPage(
      `/scenarios?open=${encodeURIComponent("run:CP-A/1/s1")}`,
    );
    const panel = document.querySelector(PANEL)!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");

    await click(container.querySelector("[data-scenarios-page]")!);
    expect(openParam(location)).toBeNull();
  });
  it("Edit scenario turns the definition panel into the editor (&edit=1), and Save writes the Library", async () => {
    const { container, service } = await renderPage(DEF_PATH);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let panel = document.querySelector(PANEL)!;
    await click(buttonIn(panel, "Edit scenario")!);

    expect(editParam(location)).toBe("1");
    expect(openParam(location)).toBe(`def:${LIBRARY_SCOPE}/cp/lib-fork`);
    // The page keeps the Library table: the editor is in the panel.
    expect(container.querySelector(LIBRARY_ROW)).toBeTruthy();
    panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    expect(name.value).toBe("Fork demo");
    expect(panel.querySelector('select[aria-label="Trigger"]')).toBeTruthy();
    expect(
      panel.querySelector('[role="group"][aria-label="Editor view"]'),
    ).toBeTruthy();
    expect(panel.querySelector('[data-testid="library-used-by"]')).toBeTruthy();
    expect(panel.querySelectorAll("[data-step-id]")).toHaveLength(5);
    // The expand button opens the Library editor page on the same scenario.
    expect(
      panel
        .querySelector('a[aria-label="Open in the Library editor"]')
        ?.getAttribute("href"),
    ).toBe("/scenarios?tab=library&edit=lib-fork");

    // The inspector goes under the steps in the narrow panel.
    await click(panel.querySelector('button[aria-label^="Select step 1"]')!);
    expect(panel.querySelector('[data-testid="step-inspector"]')).toBeTruthy();

    await act(async () => setInputValue(name, "Renamed fork"));
    await click(buttonIn(panel, "Save and apply to 1 connector")!);

    expect(confirm).toHaveBeenCalled();
    expect(service.saveScenarioDefinition).toHaveBeenCalledWith(
      LIBRARY_SCOPE,
      null,
      expect.objectContaining({ id: "lib-fork", name: "Renamed fork" }),
    );
    // The copy on CP-A #1 is re-pushed, as from the page's Save.
    expect(service.replaceConnectorScenarioDefinitions).toHaveBeenCalledWith(
      "CP-A",
      1,
      [expect.objectContaining({ id: "s1", libraryId: "lib-fork" })],
    );
  });

  it("a reload with &edit=1 reopens the panel's editor", async () => {
    await renderPage(`${DEF_PATH}&edit=1`);
    const panel = document.querySelector(PANEL)!;
    expect(
      panel.querySelector<HTMLInputElement>('input[aria-label="Scenario name"]')
        ?.value,
    ).toBe("Fork demo");
  });

  it("Cancel with unsaved changes asks in the panel and keeps editing until confirmed", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await renderPage(`${DEF_PATH}&edit=1`);
    let panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Unsaved"));

    await click(buttonIn(panel, "Cancel")!);
    const question = panel.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Discard unsaved changes?");
    expect(editParam(location)).toBe("1");
    expect(confirm).not.toHaveBeenCalled();

    await click(buttonIn(question!, "Keep editing")!);
    expect(panel.querySelector('[role="alertdialog"]')).toBeNull();
    expect(name.value).toBe("Unsaved");
    expect(editParam(location)).toBe("1");

    await click(buttonIn(panel, "Cancel")!);
    await click(
      buttonIn(panel.querySelector('[role="alertdialog"]')!, "Discard")!,
    );
    expect(editParam(location)).toBeNull();
    panel = document.querySelector(PANEL)!;
    expect(panel.querySelector('input[aria-label="Scenario name"]')).toBeNull();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
  });

  it("Cancel without changes returns to the read view at once", async () => {
    await renderPage(`${DEF_PATH}&edit=1`);
    const panel = document.querySelector(PANEL)!;
    await click(buttonIn(panel, "Cancel")!);
    expect(editParam(location)).toBeNull();
    expect(panel.querySelector('[role="alertdialog"]')).toBeNull();
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

  it("Esc in a clean editing panel returns to the read view, keeping the panel open", async () => {
    await renderPage(`${DEF_PATH}&edit=1`);
    await pressEscape();
    expect(editParam(location)).toBeNull();
    expect(openParam(location)).toBe(`def:${LIBRARY_SCOPE}/cp/lib-fork`);
    const panel = document.querySelector(PANEL)!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector('input[aria-label="Scenario name"]')).toBeNull();
    expect(panel.querySelector("h2")?.textContent).toBe("Fork demo");
  });

  it("Esc with unsaved changes asks in the panel, like Cancel", async () => {
    await renderPage(`${DEF_PATH}&edit=1`);
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Unsaved"));

    await pressEscape();
    const question = panel.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Discard unsaved changes?");
    expect(document.querySelector(PANEL)).toBeTruthy();
    expect(editParam(location)).toBe("1");

    await click(buttonIn(question!, "Keep editing")!);
    expect(name.value).toBe("Unsaved");
    expect(editParam(location)).toBe("1");

    await pressEscape();
    await click(
      buttonIn(panel.querySelector('[role="alertdialog"]')!, "Discard")!,
    );
    expect(editParam(location)).toBeNull();
    expect(openParam(location)).toBe(`def:${LIBRARY_SCOPE}/cp/lib-fork`);
    expect(
      document.querySelector(PANEL)?.querySelector("h2")?.textContent,
    ).toBe("Fork demo");
  });
  it("the close button of a dirty editing panel asks first; Discard closes the panel", async () => {
    await renderPage(`${DEF_PATH}&edit=1`);
    const panel = document.querySelector(PANEL)!;
    const name = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Scenario name"]',
    )!;
    await act(async () => setInputValue(name, "Unsaved"));
    const closeButton = () =>
      panel.querySelector<HTMLButtonElement>(
        'button[aria-label="Close side panel"]',
      );

    await click(closeButton()!);
    const question = panel.querySelector('[role="alertdialog"]');
    expect(question?.textContent).toContain("Discard unsaved changes?");
    expect(document.querySelector(PANEL)).toBeTruthy();
    await click(buttonIn(question!, "Keep editing")!);
    expect(name.value).toBe("Unsaved");
    expect(openParam(location)).toBe(`def:${LIBRARY_SCOPE}/cp/lib-fork`);

    await click(closeButton()!);
    await click(
      buttonIn(panel.querySelector('[role="alertdialog"]')!, "Discard")!,
    );
    expect(document.querySelector(PANEL)).toBeNull();
    expect(openParam(location)).toBeNull();
    expect(editParam(location)).toBeNull();
  });
});
