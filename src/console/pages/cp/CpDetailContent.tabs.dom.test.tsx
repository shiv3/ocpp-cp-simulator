// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  findMenuItem,
  flush,
  openDropdownMenu,
  pushEvent,
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../../cp/shared/Logger";
import type { StateHistoryEntry } from "../../../cp/application/services/types/StateSnapshot";
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
  connectors: [
    connector({ id: 1 }),
    connector({
      id: 2,
      status: OCPPStatus.Charging,
      transactionId: 7,
      transactionTagId: "TAG-7",
    }),
  ],
});

const txEntry: StateHistoryEntry = {
  id: "hist-1",
  timestamp: new Date("2024-01-01T00:00:00.000Z"),
  entity: "connector",
  entityId: 1,
  transitionType: "transaction",
  fromState: "Available",
  toState: "Preparing",
  context: { source: "UI", timestamp: new Date("2024-01-01T00:00:00.000Z") },
  validationResult: { level: "OK" },
  success: true,
};

describe("CpDetailContent: connector tabs, inline config, lower half", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let location: ReportedLocation | null = null;
  const locations: ReportedLocation[] = [];

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
    location = null;
    locations.length = 0;
    vi.restoreAllMocks();
  });

  async function mount(
    path: string,
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
    snapshots: ChargePointSnapshot[] = [cpA],
  ) {
    const service = createFakeChargePointService({
      snapshots,
      getStateHistory: vi.fn(async () => [txEntry]),
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
        (result.root as Root).unmount();
      });
      document.body.innerHTML = "";
    };
    await flush();
    return { ...result, service };
  }

  const tabs = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[role="tablist"][aria-label="Connectors"] [role="tab"]',
      ),
    );
  const tabByLabel = (container: HTMLElement, label: string) =>
    tabs(container).find((t) => t.textContent?.trim() === label);
  const cardIds = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-connector-id]"),
    ).map((el) => el.dataset.connectorId);
  const buttonByText = (root: ParentNode, text: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    );
  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
      await Promise.resolve();
    });
    await flush();
  };
  async function pickFromMore(label: string) {
    const more = document.body.querySelector<HTMLElement>(
      '[aria-label="More"]',
    );
    expect(more, "expected the More button").toBeTruthy();
    await openDropdownMenu(more!);
    const item = findMenuItem(label);
    expect(item, `expected a "${label}" item in the More menu`).toBeTruthy();
    await click(item!);
  }
  const sectionTabs = (root: ParentNode) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        '[role="tablist"][aria-label="Charge point sections"] [role="tab"]',
      ),
    );
  async function pickSection(label: string, root: ParentNode = document.body) {
    const tab = sectionTabs(root).find((t) => t.textContent?.trim() === label);
    expect(tab, `expected a "${label}" section tab`).toBeTruthy();
    await click(tab!);
  }
  const selectedCards = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-connector-id][data-selected="true"]',
      ),
    ).map((el) => el.dataset.connectorId);

  it("the full page shows every connector's card, no tabs, the first one marked", async () => {
    const { container } = await mount("/cp/CP-A");

    expect(tabs(container)).toEqual([]);
    expect(
      container.querySelector('[role="tablist"][aria-label="Connectors"]'),
    ).toBeNull();
    expect(cardIds(container)).toEqual(["1", "2"]);
    expect(selectedCards(container)).toEqual(["1"]);
    // Each card has its own scenario card under it.
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="scenario-card"]',
        ),
      ).map((el) => el.dataset.connectorIdRef),
    ).toEqual(["1", "2"]);
  });

  it("clicking a card's header selects it and writes ?connector=2 (replace); its controls do not", async () => {
    const { container } = await mount("/cp/CP-A");
    const header = container.querySelector<HTMLElement>(
      '[data-connector-id="2"] [data-card-header]',
    )!;

    // A control in the header acts, it does not select.
    await click(
      Array.from(header.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Controls"),
      )!,
    );
    expect(selectedCards(container)).toEqual(["1"]);

    await click(header);

    expect(selectedCards(container)).toEqual(["2"]);
    expect(location?.pathname).toBe("/cp/CP-A");
    expect(location?.search).toBe("?connector=2");
    expect(location?.type).toBe("REPLACE");
  });

  it("clicking anywhere inside a card (not on a control) selects it", async () => {
    const { container } = await mount("/cp/CP-A");
    const card = container.querySelector<HTMLElement>(
      '[data-connector-id="2"]',
    )!;
    // A figure label in the card body, well below the header.
    const label = Array.from(card.querySelectorAll("dt")).find(
      (el) => el.textContent === "Meter",
    )!;
    await click(label);
    expect(selectedCards(container)).toEqual(["2"]);
    expect(location?.search).toBe("?connector=2");

    // The Auto meter switch inside the body acts, it does not re-select 1.
    const first = container.querySelector<HTMLElement>(
      '[data-connector-id="1"]',
    )!;
    await click(
      first.querySelector('[role="switch"], input[type="checkbox"]')!,
    );
    expect(selectedCards(container)).toEqual(["2"]);
  });

  it("?connector=2 marks connector 2 on load and scrolls it into view; a missing connector falls back to the first", async () => {
    const scrolled: string[] = [];
    const options: unknown[] = [];
    Element.prototype.scrollIntoView = function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push((this as HTMLElement).dataset.connectorId ?? "");
      options.push(arg);
    };
    try {
      const { container } = await mount("/cp/CP-A?connector=2");
      expect(selectedCards(container)).toEqual(["2"]);
      expect(scrolled).toEqual(["2"]);
      // Along the row as well as down the page.
      expect(options).toEqual([{ block: "nearest", inline: "nearest" }]);
      expect(container.textContent).toContain("TAG-7");

      await cleanup!();
      cleanup = null;

      const second = await mount("/cp/CP-A?connector=9");
      expect(selectedCards(second.container)).toEqual(["1"]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("a charge point without connectors shows the empty state, not a tablist", async () => {
    const { container } = await mount("/cp/CP-E", {}, [
      snapshot({ id: "CP-E" }),
    ]);

    expect(container.textContent).toContain("No connectors");
    expect(
      container.querySelector('[role="tablist"][aria-label="Connectors"]'),
    ).toBeNull();
  });

  it("the header keeps Config, Connect/Disconnect and More; Scenarios, Edit config and Delete left it", async () => {
    const { container } = await mount("/cp/CP-A");

    const header = container.querySelector("h1")!.parentElement!.parentElement!;
    const labels = Array.from(header.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
    );
    expect(labels).toEqual(["Config", "Disconnect", "More"]);
    expect(buttonByText(container, "Edit config")).toBeUndefined();
    expect(buttonByText(container, "Delete")).toBeUndefined();
    expect(
      Array.from(header.querySelectorAll("a")).some(
        (a) => a.textContent?.trim() === "Scenarios",
      ),
    ).toBe(false);
  });

  it("Config toggles the inline form; Save updates the charge point (remote) and closes it; Cancel hides it", async () => {
    const { container, service } = await mount("/cp/CP-A");
    const config = buttonByText(container, "Config")!;
    expect(config.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("cpId")).toBeNull();

    await click(config);

    expect(config.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("cpId")).toBeTruthy();
    // Inline, not a dialog.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await click(buttonByText(container, "Save")!);

    expect(service.updateChargePoint).toHaveBeenCalledTimes(1);
    expect(service.updateChargePoint).toHaveBeenCalledWith(
      expect.objectContaining({ cpId: "CP-A" }),
    );
    expect(document.getElementById("cpId")).toBeNull();
    expect(config.getAttribute("aria-expanded")).toBe("false");

    await click(config);
    expect(document.getElementById("cpId")).toBeTruthy();
    await click(buttonByText(container, "Cancel")!);
    expect(document.getElementById("cpId")).toBeNull();
    expect(service.updateChargePoint).toHaveBeenCalledTimes(1);
  });

  it("an open form keeps what was typed while log events re-render the page", async () => {
    const { container, service } = await mount("/cp/CP-A");
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA] });
      }
      await Promise.resolve();
    });
    await flush();
    await click(buttonByText(container, "Config")!);

    const vendor = document.getElementById(
      "chargePointVendor",
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(vendor, "Typed vendor");
      vendor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await pushEvent(service as FakeChargePointService, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:00.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "re-render trigger",
      },
    });
    await flush();

    expect(
      (document.getElementById("chargePointVendor") as HTMLInputElement).value,
    ).toBe("Typed vendor");
  });

  it("the lower half is the message log with a link to the Message Log page filtered to this charge point", async () => {
    const { container, service } = await mount("/cp/CP-A");
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA] });
      }
      await Promise.resolve();
    });
    await flush();
    await pushEvent(service as FakeChargePointService, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date("2026-01-01T10:00:00.000Z"),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        // Names connector 1, the selected one: the tab filters to it.
        message: "BootNotification accepted on connector 1",
      },
    });
    await flush();

    const log = container.querySelector('[data-testid="cp-message-log"]');
    expect(log, "expected the message log section").toBeTruthy();
    expect(log!.textContent).toContain("BootNotification accepted");
    // The link sits in the bottom panel's header bar, beside the tab strip.
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="bottom-panel"]',
    )!;
    const link = Array.from(panel.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open in Message Log"),
    );
    expect(link?.getAttribute("href")).toBe("/logs?cp=CP-A");
  });

  it("the Message log tab is the Message Log page's viewer on this charge point's lines: sidebar, toolbar, search, table", async () => {
    const clearStoredLogs = vi.fn(async () => {});
    const { container, service } = await mount("/cp/CP-A", {
      clearStoredLogs,
    });
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA] });
      }
      await Promise.resolve();
    });
    await flush();
    // Both name connector 1, the selected one: the tab filters to it.
    for (const message of [
      "first line, connector 1",
      "second line, connector 1",
    ]) {
      await pushEvent(service as FakeChargePointService, "CP-A", {
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

    const log = container.querySelector<HTMLElement>(
      '[data-testid="cp-message-log"]',
    )!;
    const toolbar = log.querySelector('[data-testid="log-toolbar"]');
    expect(toolbar?.textContent).toContain("2 total / 2 filtered");
    expect(
      log.querySelector('input[placeholder="Search in messages..."]'),
    ).toBeTruthy();
    expect(log.querySelector("table")).toBeTruthy();
    // Oldest first, and no Charge point column: the lines are all this one's.
    const text = log.textContent ?? "";
    expect(text.indexOf("first line")).toBeLessThan(
      text.indexOf("second line"),
    );
    expect(
      Array.from(log.querySelectorAll("th")).map((th) => th.textContent),
    ).not.toContain("Charge point");

    await click(buttonByText(log, "Clear screen")!);
    expect(log.textContent).not.toContain("first line");
    expect(clearStoredLogs).not.toHaveBeenCalled();

    await click(buttonByText(log, "Clear screen + DB")!);
    expect(clearStoredLogs).toHaveBeenCalledWith("CP-A");
  });

  /** Log lines that name connector 1, connector 2 and no connector. */
  async function seedConnectorLogs(
    service: FakeChargePointService,
    cpId = "CP-A",
  ) {
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA] });
      }
      await Promise.resolve();
    });
    await flush();
    for (const message of [
      "line for connector 1",
      "line for connector 2",
      "line for the charge point",
    ]) {
      await pushEvent(service, cpId, {
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
  }
  const logRows = (root: ParentNode) =>
    Array.from(
      root.querySelectorAll('[data-testid="cp-message-log"] tbody tr'),
    ).map((tr) => tr.textContent ?? "");
  const showEveryConnector = (root: ParentNode) =>
    root.querySelector<HTMLElement>('[aria-label="Show every connector"]');
  /** The chip is the button's wrapper in the bottom panel's header bar. */
  const connectorChip = (root: ParentNode) =>
    showEveryConnector(root)?.parentElement ?? undefined;

  it("the Message log follows the selected connector: a chip names it, its x shows every connector", async () => {
    const { container, service } = await mount("/cp/CP-A");
    await seedConnectorLogs(service as FakeChargePointService);

    // Connector 1 is the active one: only its lines.
    let rows = logRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("line for connector 1");
    expect(connectorChip(container)?.textContent).toContain("Connector 1");

    await click(
      container.querySelector<HTMLElement>(
        '[data-connector-id="2"] [data-card-header]',
      )!,
    );
    rows = logRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("line for connector 2");
    expect(connectorChip(container)?.textContent).toContain("Connector 2");

    await click(showEveryConnector(container)!);
    expect(logRows(container)).toHaveLength(3);
    expect(connectorChip(container)).toBeUndefined();
    expect(showEveryConnector(container)).toBeNull();

    // Selecting a connector narrows it again.
    await click(
      container.querySelector<HTMLElement>(
        '[data-connector-id="1"] [data-card-header]',
      )!,
    );
    rows = logRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("line for connector 1");
    expect(connectorChip(container)?.textContent).toContain("Connector 1");
  });

  it("widening the filter in the sidebar hides the chip and holds until the selection changes", async () => {
    const { container, service } = await mount("/cp/CP-A");
    await seedConnectorLogs(service as FakeChargePointService);

    const option = (label: string) =>
      container.querySelector<HTMLInputElement>(
        `[data-filter-group="Connector"] label[data-filter-option="${label}"] input`,
      )!;
    await click(option("Connector 2"));
    expect(logRows(container)).toHaveLength(2);
    expect(connectorChip(container)).toBeUndefined();
  });

  it("encodes the charge point id in the Message Log link", async () => {
    const weird = snapshot({
      id: "CP?x#1",
      connectors: [connector({ id: 1 })],
    });
    const { container } = await mount("/cp/CP%3Fx%231", {}, [weird]);

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open in Message Log"),
    );
    expect(link?.getAttribute("href")).toBe("/logs?cp=CP%3Fx%231");
  });

  it("More lists only Scenarios and Delete (last)", async () => {
    await mount("/cp/CP-A");
    const more = document.body.querySelector<HTMLElement>(
      '[aria-label="More"]',
    )!;
    await openDropdownMenu(more);

    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((el) => el.textContent?.trim());
    expect(items).toEqual(["Scenarios", "Delete"]);
    expect(findMenuItem("Scenarios")?.getAttribute("href")).toBe(
      "/scenarios?tab=library&cp=CP-A",
    );
  });

  it("the lower half is an underline tab strip of the sections, Message log first", async () => {
    await mount("/cp/CP-A");
    expect(
      sectionTabs(document.body).map((t) => t.textContent?.trim()),
    ).toEqual([
      "Message log",
      "Transactions",
      "Session analysis",
      "Diagnostics",
      "Expert",
      "Network simulation",
    ]);
    expect(
      sectionTabs(document.body).map((t) => t.getAttribute("aria-selected")),
    ).toEqual(["true", "false", "false", "false", "false", "false"]);
  });

  it("the page root has a scroll area with the bottom panel after it", async () => {
    const { container } = await mount("/cp/CP-A");
    const scroll = container.querySelector<HTMLElement>(
      '[data-testid="cp-scroll-area"]',
    )!;
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="bottom-panel"]',
    )!;
    expect(scroll).toBeTruthy();
    expect(panel).toBeTruthy();
    expect(scroll.parentElement).toBe(panel.parentElement);
    expect(scroll.nextElementSibling).toBe(panel);
    expect(scroll.className).toContain("overflow-y-auto");
    // The tab strip lives in the panel, not in the scroll area.
    expect(
      scroll.querySelector(
        '[role="tablist"][aria-label="Charge point sections"]',
      ),
    ).toBeNull();
    expect(
      panel.querySelector(
        '[role="tablist"][aria-label="Charge point sections"]',
      ),
    ).toBeTruthy();
  });

  it("the Open in Message Log link sits in the bottom panel's header bar on the log tab only", async () => {
    const { container } = await mount("/cp/CP-A");
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="bottom-panel"]',
    )!;
    const bar =
      panel.querySelector<HTMLElement>('[role="tablist"]')!.parentElement!;
    const linkIn = (root: ParentNode) =>
      Array.from(root.querySelectorAll("a")).find((a) =>
        a.textContent?.includes("Open in Message Log"),
      );
    expect(linkIn(bar)).toBeTruthy();

    await pickSection("Transactions");
    expect(linkIn(container)).toBeUndefined();

    await pickSection("Message log");
    expect(linkIn(bar)).toBeTruthy();
  });

  it("the log viewer's filter sidebar starts closed in the side panel and open on the page", async () => {
    const sidebarOf = (root: HTMLElement) => {
      const log = root.querySelector<HTMLElement>(
        '[data-testid="cp-message-log"]',
      )!;
      return log.querySelector<HTMLElement>("[data-filter-group]")!
        .parentElement!.parentElement!;
    };
    const filtersButton = (root: HTMLElement) =>
      root.querySelector<HTMLElement>(
        '[data-testid="cp-message-log"] button[aria-label="Filters"]',
      )!;

    const panel = await mount("/?cp=CP-A");
    expect(sidebarOf(panel.container).hasAttribute("hidden")).toBe(true);
    expect(filtersButton(panel.container).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await click(filtersButton(panel.container));
    expect(sidebarOf(panel.container).hasAttribute("hidden")).toBe(false);
    await cleanup!();
    cleanup = null;

    const page = await mount("/cp/CP-A");
    expect(sidebarOf(page.container).hasAttribute("hidden")).toBe(false);
    expect(filtersButton(page.container).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("the side panel also gets the bottom panel under its scrolling upper part", async () => {
    const { container } = await mount("/?cp=CP-A");
    const aside = container.querySelector<HTMLElement>(
      'aside[aria-label="Charge point"]',
    )!;
    const panel = aside.querySelector<HTMLElement>(
      '[data-testid="bottom-panel"]',
    )!;
    expect(panel).toBeTruthy();
    expect(panel.previousElementSibling?.className).toContain(
      "overflow-y-auto",
    );
  });

  it("the Transactions tab sets ?tab=transactions and swaps the lower half; the Message log tab returns", async () => {
    const { container, service } = await mount("/cp/CP-A");
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();

    await pickSection("Transactions");

    expect(location?.search).toBe("?tab=transactions");
    expect(location?.type).toBe("REPLACE");
    expect(service.getStateHistory).toHaveBeenCalledWith("CP-A", {
      transitionType: "transaction",
    });
    expect(container.textContent).toContain("Available → Preparing");
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeNull();

    await pickSection("Message log");

    expect(location?.search).toBe("");
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();
  });

  it("?tab= opens a section on load; an unknown value shows the message log", async () => {
    const { container } = await mount("/cp/CP-A?tab=expert", {}, [
      snapshot({
        ...cpA,
        config: { ocppVersion: "OCPP-1.6J" } as ChargePointSnapshot["config"],
      }),
    ]);
    expect(container.querySelector('select[aria-label="Action"]')).toBeTruthy();
    expect(
      sectionTabs(container)
        .find((t) => t.getAttribute("aria-selected") === "true")
        ?.textContent?.trim(),
    ).toBe("Expert");

    await cleanup!();
    cleanup = null;
    const other = await mount("/cp/CP-A?tab=nonsense");
    expect(
      other.container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();
  });

  it("Diagnostics defaults its connector select to the selected connector", async () => {
    const { container } = await mount("/cp/CP-A?connector=2&tab=diagnostics");

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="diagnostics-connector"]',
    );
    expect(select?.value).toBe("2");
  });

  it("without network simulation there is no such tab and ?tab=network shows the log", async () => {
    const noSim = snapshot({
      id: "CP-A",
      connectors: [connector({ id: 1 })],
      networkSim: null,
    });
    const { container } = await mount("/cp/CP-A?tab=network", {}, [noSim]);
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();

    expect(
      sectionTabs(container).map((t) => t.textContent?.trim()),
    ).not.toContain("Network simulation");
  });

  it("More → Delete confirms, removes the charge point and goes back to the list", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const removeChargePoint = vi.fn(async () => {});
    const { container } = await mount("/cp/CP-A", { removeChargePoint });

    await pickFromMore("Delete");

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Delete charge point CP-A?"),
    );
    expect(removeChargePoint).toHaveBeenCalledWith("CP-A");
    expect(container.querySelector("h1")?.textContent?.trim()).toBe(
      "Charge Points",
    );
  });

  describe("in the side panel", () => {
    it("selecting a connector keeps cp and tab in the URL", async () => {
      const { container } = await mount("/?cp=CP-A&tab=transactions");
      const panel = container.querySelector<HTMLElement>(
        'aside[aria-label="Charge point"]',
      )!;
      expect(
        panel.querySelector('[role="tablist"][aria-label="Connectors"]'),
      ).toBeTruthy();

      await click(tabByLabel(panel, "#2")!);

      expect(new URLSearchParams(location!.search).get("cp")).toBe("CP-A");
      expect(new URLSearchParams(location!.search).get("connector")).toBe("2");
      expect(new URLSearchParams(location!.search).get("tab")).toBe(
        "transactions",
      );
    });

    it("shows the tabs and only the selected connector's card; #2 swaps it", async () => {
      const { container } = await mount("/?cp=CP-A");
      const panel = container.querySelector<HTMLElement>(
        'aside[aria-label="Charge point"]',
      )!;
      expect(tabs(panel).map((t) => t.textContent?.trim())).toEqual([
        "#1",
        "#2",
      ]);
      expect(cardIds(panel)).toEqual(["1"]);

      await click(tabByLabel(panel, "#2")!);

      expect(cardIds(panel)).toEqual(["2"]);
      expect(tabByLabel(panel, "#2")!.getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(location?.type).toBe("REPLACE");
    });

    it("the Session analysis tab writes ?tab=analysis beside ?cp=", async () => {
      await mount("/?cp=CP-A");

      await pickSection("Session analysis");

      expect(new URLSearchParams(location!.search).get("cp")).toBe("CP-A");
      expect(new URLSearchParams(location!.search).get("tab")).toBe("analysis");
    });

    it("closing the panel drops tab as well", async () => {
      const { container } = await mount("/?cp=CP-A&connector=2&tab=expert");
      const close = container.querySelector<HTMLElement>(
        '[aria-label="Close side panel"]',
      )!;

      await click(close);

      expect(location?.search).toBe("");
    });
  });
});
