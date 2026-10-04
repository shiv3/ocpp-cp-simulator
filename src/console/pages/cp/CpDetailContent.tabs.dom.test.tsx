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

  it("renders one tab per connector and only the first connector's card", async () => {
    const { container } = await mount("/cp/CP-A");

    expect(tabs(container).map((t) => t.textContent?.trim())).toEqual([
      "#1",
      "#2",
    ]);
    expect(tabByLabel(container, "#1")!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(tabByLabel(container, "#2")!.getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(cardIds(container)).toEqual(["1"]);
  });

  it("clicking #2 shows connector 2's card and writes ?connector=2 (replace)", async () => {
    const { container } = await mount("/cp/CP-A");

    await click(tabByLabel(container, "#2")!);

    expect(cardIds(container)).toEqual(["2"]);
    expect(tabByLabel(container, "#2")!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(location?.pathname).toBe("/cp/CP-A");
    expect(location?.search).toBe("?connector=2");
    expect(location?.type).toBe("REPLACE");
  });

  it("?connector=2 selects connector 2 on load; a missing connector falls back to the first", async () => {
    const { container } = await mount("/cp/CP-A?connector=2");
    expect(cardIds(container)).toEqual(["2"]);
    expect(container.textContent).toContain("TAG-7");

    await cleanup!();
    cleanup = null;

    const second = await mount("/cp/CP-A?connector=9");
    expect(cardIds(second.container)).toEqual(["1"]);
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
        message: "BootNotification accepted",
      },
    });
    await flush();

    const log = container.querySelector('[data-testid="cp-message-log"]');
    expect(log, "expected the message log section").toBeTruthy();
    expect(log!.textContent).toContain("Message Log");
    expect(log!.textContent).toContain("BootNotification accepted");
    const link = Array.from(log!.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open in Message Log"),
    );
    expect(link?.getAttribute("href")).toBe("/logs?cp=CP-A");
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

  it("More lists the sections, Scenarios and Delete (last)", async () => {
    await mount("/cp/CP-A");
    const more = document.body.querySelector<HTMLElement>(
      '[aria-label="More"]',
    )!;
    await openDropdownMenu(more);

    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((el) => el.textContent?.trim());
    expect(items).toEqual([
      "Message log",
      "Transactions",
      "Session analysis",
      "Diagnostics",
      "Expert",
      "Network simulation",
      "Scenarios",
      "Delete",
    ]);
    expect(findMenuItem("Scenarios")?.getAttribute("href")).toBe(
      "/scenarios?tab=library&cp=CP-A",
    );
  });

  it("More → Transactions sets ?tab=transactions and swaps the lower half; ← Message log returns", async () => {
    const { container, service } = await mount("/cp/CP-A");
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();

    await pickFromMore("Transactions");

    expect(location?.search).toBe("?tab=transactions");
    expect(location?.type).toBe("REPLACE");
    expect(service.getStateHistory).toHaveBeenCalledWith("CP-A", {
      transitionType: "transaction",
    });
    expect(container.textContent).toContain("Available → Preparing");
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeNull();

    const back = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Message log"),
    );
    expect(back, "expected a ← Message log link").toBeTruthy();
    await click(back!);

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

  it("without network simulation the More menu has no such item and ?tab=network shows the log", async () => {
    const noSim = snapshot({
      id: "CP-A",
      connectors: [connector({ id: 1 })],
      networkSim: null,
    });
    const { container } = await mount("/cp/CP-A?tab=network", {}, [noSim]);
    expect(
      container.querySelector('[data-testid="cp-message-log"]'),
    ).toBeTruthy();

    const more = document.body.querySelector<HTMLElement>(
      '[aria-label="More"]',
    )!;
    await openDropdownMenu(more);
    expect(findMenuItem("Network simulation")).toBeUndefined();
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

    it("More → Session analysis writes ?tab=analysis beside ?cp=", async () => {
      await mount("/?cp=CP-A");

      await pickFromMore("Session analysis");

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
