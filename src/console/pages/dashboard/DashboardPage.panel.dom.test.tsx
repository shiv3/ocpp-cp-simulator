// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createFakeChargePointService,
  flush,
  pushEvent,
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../../cp/shared/Logger";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

function connector(
  overrides: Partial<ChargePointSnapshot["connectors"][number]> & {
    id: number;
  },
): ChargePointSnapshot["connectors"][number] {
  return {
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
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ChargePointSnapshot> & { id: string },
): ChargePointSnapshot {
  return {
    status: OCPPStatus.Available,
    error: "",
    connectors: [],
    ...overrides,
  };
}

const cpA = snapshot({
  id: "CP-A",
  connectors: [connector({ id: 1 }), connector({ id: 2 })],
});
const cpB = snapshot({ id: "CP-B", connectors: [connector({ id: 1 })] });

/** Remote mode lists charge points only from registry events. */
async function pushRegistry(
  service: FakeChargePointService,
  cps: ChargePointSnapshot[],
): Promise<void> {
  await act(async () => {
    for (const handler of service.__handlers.subscribeRegistry) {
      handler({ type: "snapshot", cps });
    }
    await Promise.resolve();
  });
  await flush();
}

describe("DashboardPage side panel", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let location: ReportedLocation | null = null;
  const locations: ReportedLocation[] = [];

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    location = null;
    locations.length = 0;
    try {
      window.localStorage.clear();
    } catch {
      // storage unavailable: the panel falls back to its default width
    }
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function mount(
    path: string,
    snapshots: ChargePointSnapshot[] = [cpA, cpB],
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
  ) {
    const service = createFakeChargePointService({
      snapshots,
      // The panel renders the Transactions tab, which reads the state history.
      getStateHistory: vi.fn(async () => []),
      listScenarios: vi.fn(async () => []),
      getNetworkSimGlobal: vi.fn(async () => null),
      getNetworkSimCp: vi.fn(async () => ({
        config: null,
        resolved: {} as never,
      })),
      ...overrides,
    });
    const result = await renderConsole(path, {
      service,
      onLocationChange: (next) => {
        location = next;
        locations.push(next);
      },
    });
    cleanup = async () => {
      await act(async () => {
        result.root.unmount();
      });
      document.body.innerHTML = "";
    };
    await pushRegistry(service, snapshots);
    return { ...result, service, root: result.root as Root };
  }

  const panelOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('aside[aria-label="Charge point"]');
  // The row head of the Hierarchy view: it carries `data-cp-id`.
  const rowOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-cp-id="${id}"]`)!;
  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
      await Promise.resolve();
    });
    await flush();
  };
  const buttonByText = (root: Element, text: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    );

  it("opens the charge point in a panel beside the list when its row is clicked", async () => {
    const { container } = await mount("/");
    expect(panelOf(container)).toBeNull();

    await click(rowOf(container, "CP-A"));

    const panel = panelOf(container);
    expect(panel, "expected the side panel").toBeTruthy();
    expect(panel!.querySelector("h2")?.textContent).toBe("CP-A");
    expect(buttonByText(panel!, "Config")).toBeTruthy();
    expect(location?.pathname).toBe("/");
    expect(location?.search).toBe("?cp=CP-A");
    expect(rowOf(container, "CP-A").getAttribute("data-selected")).toBe("true");
    expect(rowOf(container, "CP-B").hasAttribute("data-selected")).toBe(false);
    // The list stays on screen next to the panel.
    expect(container.querySelector("h1")?.textContent).toBe("Charge Points");
  });

  it("opens the panel from the charge point id and the id no longer links to the full page", async () => {
    const { container } = await mount("/");
    const row = rowOf(container, "CP-A");
    expect(row.querySelector('a[href^="/cp/"]')).toBeNull();
    expect(buttonByText(row, "Open")).toBeUndefined();

    await click(buttonByText(row, "CP-A")!);

    expect(panelOf(container)).toBeTruthy();
    expect(location?.search).toBe("?cp=CP-A");
  });

  it("a connector cell opens the panel on that connector", async () => {
    const { container } = await mount("/");

    await click(container.querySelector('[data-connector-cell="CP-A#2"]')!);

    expect(panelOf(container)).toBeTruthy();
    expect(location?.search).toBe("?cp=CP-A&connector=2");
  });

  it("the panel's Message log follows the selected connector tab: a chip names it, its x shows both", async () => {
    const { container, service } = await mount("/?cp=CP-A");
    for (const message of ["line for connector 1", "line for connector 2"]) {
      await pushEvent(service, "CP-A", {
        type: "log",
        entry: {
          timestamp: new Date("2026-01-01T10:00:00.000Z"),
          level: LogLevel.INFO,
          type: LogType.OCPP,
          message,
        },
      });
    }
    await flush();
    const panel = panelOf(container)!;
    const rows = () =>
      Array.from(
        panel.querySelectorAll('[data-testid="cp-message-log"] tbody tr'),
      ).map((tr) => tr.textContent ?? "");
    const tab = (label: string) =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          '[role="tablist"][aria-label="Connectors"] [role="tab"]',
        ),
      ).find((t) => t.textContent?.trim() === label)!;
    const showEvery = () =>
      panel.querySelector<HTMLElement>('[aria-label="Show every connector"]');
    // The chip is the button's wrapper in the bottom panel's header bar.
    const chip = () => showEvery()?.parentElement ?? undefined;

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("line for connector 1");
    expect(chip()?.textContent).toContain("Connector 1");

    await click(tab("#2"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("line for connector 2");
    expect(chip()?.textContent).toContain("Connector 2");

    await click(showEvery()!);
    expect(rows()).toHaveLength(2);
    expect(chip()).toBeUndefined();

    await click(tab("#1"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("line for connector 1");
    expect(chip()?.textContent).toContain("Connector 1");
  });

  it("clicking another row swaps the panel (replace), clicking it again closes it (replace)", async () => {
    const { container } = await mount("/");

    await click(rowOf(container, "CP-A"));
    expect(locations.at(-1)?.type).toBe("PUSH");

    await click(rowOf(container, "CP-B"));
    expect(panelOf(container)!.querySelector("h2")?.textContent).toBe("CP-B");
    expect(location?.search).toBe("?cp=CP-B");
    expect(locations.at(-1)?.type).toBe("REPLACE");
    expect(rowOf(container, "CP-A").hasAttribute("data-selected")).toBe(false);

    await click(rowOf(container, "CP-B"));
    expect(panelOf(container)).toBeNull();
    expect(location?.search).toBe("");
    expect(locations.at(-1)?.type).toBe("REPLACE");
  });

  it("swapping to another charge point drops ?tab=, selecting a connector on the same one keeps it", async () => {
    const { container } = await mount("/?cp=CP-A&tab=transactions");

    // Same charge point, another connector: the section stays.
    await click(container.querySelector('[data-connector-cell="CP-A#2"]')!);
    expect(location?.search).toBe("?cp=CP-A&tab=transactions&connector=2");

    // Another charge point opens on its message log.
    await click(rowOf(container, "CP-B"));
    expect(location?.search).toBe("?cp=CP-B");
  });

  it("the close button closes the panel", async () => {
    const { container } = await mount("/?cp=CP-A");
    const close = panelOf(container)!.querySelector(
      '[aria-label="Close side panel"]',
    );
    expect(close, "expected a close button").toBeTruthy();

    await click(close!);

    expect(panelOf(container)).toBeNull();
    expect(location?.search).toBe("");
  });

  it("Esc closes the panel", async () => {
    const { container } = await mount("/?cp=CP-A");

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(panelOf(container)).toBeNull();
    expect(location?.search).toBe("");
  });

  it("a click on the list background closes the panel, but a click on the header's button does not", async () => {
    const { container } = await mount("/?cp=CP-A&connector=2");

    const addButton = buttonByText(container, "Add Charge Point")!;
    await click(addButton);
    expect(panelOf(container), "a button is not the background").toBeTruthy();

    await click(container.querySelector("h1")!);

    expect(panelOf(container)).toBeNull();
    expect(location?.search).toBe("");
  });

  it("?cp= in the URL shows the panel on load, scrolling the row into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { container } = await mount("/?cp=CP-A&connector=2");

      const panel = panelOf(container);
      expect(panel).toBeTruthy();
      expect(panel!.querySelector("h2")?.textContent).toBe("CP-A");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(rowOf(container, "CP-A"));
    } finally {
      // jsdom has no scrollIntoView: restore that
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("re-reads the charge point once the list names it (a reload in Local mode)", async () => {
    const service = createFakeChargePointService({
      snapshots: [cpA, cpB],
      getStateHistory: vi.fn(async () => []),
      listScenarios: vi.fn(async () => []),
      getNetworkSimGlobal: vi.fn(async () => null),
      getNetworkSimCp: vi.fn(async () => ({
        config: null,
        resolved: {} as never,
      })),
    });
    // The snapshot is empty until the registry answers, as when the local
    // service has not created the charge point yet.
    const snapshots = new Map<string, ChargePointSnapshot>();
    service.getChargePoint = vi.fn(
      async (id: string) => snapshots.get(id) ?? null,
    );
    const result = await renderConsole("/?cp=CP-A&connector=2", { service });
    cleanup = async () => {
      await act(async () => {
        result.root.unmount();
      });
      document.body.innerHTML = "";
    };
    let panel = panelOf(result.container);
    expect(panel!.querySelector("h2")?.textContent).toBe("CP-A");
    // The connector tabs (the lower half has its own tab strip).
    const connectorTabs = (root: Element) =>
      root.querySelectorAll(
        '[role="tablist"][aria-label="Connectors"] [role="tab"]',
      );
    expect(connectorTabs(panel!)).toHaveLength(0);

    snapshots.set("CP-A", cpA);
    await pushRegistry(service, [cpA, cpB]);
    await flush();
    panel = panelOf(result.container);
    expect(connectorTabs(panel!)).toHaveLength(cpA.connectors.length);
  });

  it("the expand control opens the full page on the same connector", async () => {
    const { container } = await mount("/?cp=CP-A&connector=2");

    const expand = panelOf(container)!.querySelector<HTMLAnchorElement>(
      '[aria-label="Open as full page"]',
    );
    expect(expand?.getAttribute("href")).toBe("/cp/CP-A?connector=2");

    await click(expand!);

    expect(location?.pathname).toBe("/cp/CP-A");
    expect(location?.search).toBe("?connector=2");
    expect(location?.state).toEqual({ from: "/" });
    expect(container.querySelector("h1")?.textContent).toBe("CP-A");
  });

  it("the full page's back link returns to the list with the panel open", async () => {
    const { container } = await mount("/cp/CP-A?connector=2");

    const back = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to charge points"),
    );
    expect(back?.getAttribute("href")).toBe("/?cp=CP-A&connector=2");

    await click(back!);

    expect(panelOf(container)!.querySelector("h2")?.textContent).toBe("CP-A");
  });

  it("encodes a special-character id in the panel's URL and in the expand link", async () => {
    const special = snapshot({ id: "CP?weird#id" });
    const { container } = await mount("/", [special]);

    await click(rowOf(container, "CP?weird#id"));

    expect(location?.search).toBe("?cp=CP%3Fweird%23id");
    const expand = panelOf(container)!.querySelector(
      '[aria-label="Open as full page"]',
    );
    expect(expand?.getAttribute("href")).toBe("/cp/CP%3Fweird%23id");
  });
});
