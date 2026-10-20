// @vitest-environment jsdom
import { act } from "react";
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
  renderConsole,
  type FakeChargePointService,
  type ReportedLocation,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
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
  config: { ocppVersion: "1.6J" } as ChargePointSnapshot["config"],
  connectors: [
    connector({ id: 1, meterValue: 16208 }),
    connector({
      id: 2,
      status: OCPPStatus.Charging,
      transactionId: 42,
      meterValue: 3200,
    }),
  ],
});
const cpB = snapshot({
  id: "CP-B",
  config: { ocppVersion: "2.0.1" } as ChargePointSnapshot["config"],
  connectors: [connector({ id: 1 })],
});
// Unavailable status: not connected (no transport, no OCPP status).
const cpC = snapshot({
  id: "CP-C",
  status: OCPPStatus.Unavailable,
  config: { ocppVersion: "1.6J" } as ChargePointSnapshot["config"],
  connectors: [connector({ id: 1, status: OCPPStatus.Unavailable })],
});

describe("DashboardPage views and filters", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let location: ReportedLocation | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    location = null;
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

  async function pushRegistry(
    service: FakeChargePointService,
    cps: ChargePointSnapshot[],
  ) {
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps });
      }
      await Promise.resolve();
    });
    await flush();
  }

  async function mount(
    path: string,
    snapshots: ChargePointSnapshot[] = [cpA, cpB, cpC],
    overrides: Parameters<typeof createFakeChargePointService>[0] = {},
  ) {
    const service = createFakeChargePointService({
      snapshots,
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
      },
    });
    cleanup = async () => {
      await act(async () => {
        result.root.unmount();
      });
      document.body.innerHTML = "";
    };
    await pushRegistry(service, snapshots);
    return { ...result, service };
  }

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
  const cells = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-connector-cell]"),
    );
  const cellOf = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLElement>(`[data-connector-cell="${key}"]`)!;
  const counter = (container: HTMLElement) =>
    container.querySelector('[data-testid="cp-list-count"]')?.textContent;
  const headOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-cp-id="${id}"]`)!;

  /** React tracks form values through the native setters. */
  async function setValue(
    el: HTMLInputElement | HTMLSelectElement,
    value: string,
    event: "input" | "change",
  ) {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(event, { bubbles: true }));
    });
    await flush();
  }

  it("Hierarchy (the default) shows a cell per connector with #n, status and Tx / kWh", async () => {
    const { container } = await mount("/");

    expect(
      buttonByText(container, "Hierarchy")!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector("table")).toBeNull();
    expect(cells(container)).toHaveLength(4);

    const c1 = cellOf(container, "CP-A#1");
    expect(c1.textContent).toContain("#1");
    expect(c1.textContent).toContain("Available");
    // The meter is in Wh (#368); no transaction, so the energy shows.
    expect(c1.textContent).toContain("16.21 kWh");

    const c2 = cellOf(container, "CP-A#2");
    expect(c2.textContent).toContain("#2");
    expect(c2.textContent).toContain("Charging");
    // A transaction replaces the energy.
    expect(c2.textContent).toContain("Tx 42");
    expect(c2.textContent).not.toContain("kWh");

    // Zero energy and no transaction: nothing at the right.
    expect(cellOf(container, "CP-B#1").textContent).toBe("#1Available");

    expect(container.textContent).not.toContain("Recent activity");
    expect(counter(container)).toBe("3 CPs · 4 connectors");
  });

  it("each charge point row has its version, status and a dot per connector", async () => {
    const { container } = await mount("/");
    const head = headOf(container, "CP-A");
    expect(head.textContent).toContain("1.6J");
    expect(head.textContent).toContain("Available");
    expect(head.querySelector('[title="#1 Available"]')).toBeTruthy();
    expect(head.querySelector('[title="#2 Charging"]')).toBeTruthy();
    expect(headOf(container, "CP-C").textContent).toContain("Disconnected");
  });

  it("?view=cp shows a table with the In use column", async () => {
    const { container } = await mount("/?view=cp");

    expect(
      buttonByText(container, "Charge points")!.getAttribute("aria-pressed"),
    ).toBe("true");
    const table = container.querySelector("table")!;
    expect(table).toBeTruthy();
    const headers = Array.from(table.querySelectorAll("th")).map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toContain("In use");
    expect(headers).toContain("Heartbeat");
    expect(cells(container)).toHaveLength(0);

    const rowA = table.querySelector<HTMLElement>('tr[data-cp-id="CP-A"]')!;
    // CP-A: one of two connectors is Charging.
    expect(rowA.textContent).toContain("1 / 2");
    expect(rowA.textContent).toContain("1.6J");
    expect(rowA.textContent).toContain("never");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("?view=connectors shows one row per connector", async () => {
    const { container } = await mount("/?view=connectors");

    const table = container.querySelector("table")!;
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("CP-A #1");
    expect(rows[0].textContent).toContain("16.21 kWh");
    expect(rows[1].textContent).toContain("CP-A #2");
    expect(rows[1].textContent).toContain("#42");
    expect(rows[1].textContent).toContain("Charging");
  });

  it("the view switch writes ?view= and the default view leaves it out", async () => {
    const { container } = await mount("/");
    const group = container.querySelector('[role="group"][aria-label="View"]')!;
    expect(
      Array.from(group.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["Hierarchy", "Charge points", "Connectors"]);

    await click(buttonByText(group as HTMLElement, "Connectors")!);
    expect(location?.search).toBe("?view=connectors");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);

    await click(buttonByText(group as HTMLElement, "Charge points")!);
    expect(location?.search).toBe("?view=cp");

    await click(buttonByText(group as HTMLElement, "Hierarchy")!);
    expect(location?.search).toBe("");
    expect(cells(container)).toHaveLength(4);
  });

  it("the header actions read: view switch, Bulk actions, Add Charge Point", async () => {
    const { container } = await mount("/");
    // The header's actions container holds the switch's group and the buttons.
    const actions = container.querySelector(
      '[role="group"][aria-label="View"]',
    )!.parentElement!;
    const labels = Array.from(actions.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    const view = labels.indexOf("Hierarchy");
    const bulk = labels.indexOf("All charge points");
    const add = labels.indexOf("Add Charge Point");
    expect(view).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeGreaterThan(view);
    expect(add).toBeGreaterThan(bulk);
  });

  it("the Status select hides non-matching connectors and the counter follows", async () => {
    const { container } = await mount("/");
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Status"]',
    )!;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Any status",
      "Available",
      "Preparing",
      "Charging",
      "SuspendedEVSE",
      "SuspendedEV",
      "Finishing",
      "Reserved",
      "Unavailable",
      "Faulted",
    ]);

    await setValue(select, OCPPStatus.Charging, "change");

    expect(location?.search).toBe("?status=Charging");
    // Only CP-A's connector 2 is Charging: the other charge points go away
    // with their connectors.
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#2",
    ]);
    expect(container.querySelector('[data-cp-id="CP-B"]')).toBeNull();
    expect(counter(container)).toBe("1 CPs · 1 connectors");
  });

  it("an empty result shows the no-match state", async () => {
    const { container } = await mount("/?status=Faulted");
    expect(container.textContent).toContain(
      "No charge points match the current filters.",
    );
    expect(counter(container)).toBe("0 CPs · 0 connectors");
  });

  it("Connected hides a disconnected charge point", async () => {
    const { container } = await mount("/");
    expect(headOf(container, "CP-C")).toBeTruthy();

    const checkbox = Array.from(
      container.querySelectorAll<HTMLLabelElement>("label"),
    )
      .find((l) => l.textContent?.trim() === "Connected")!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(checkbox);

    expect(location?.search).toBe("?connected=1");
    expect(container.querySelector('[data-cp-id="CP-C"]')).toBeNull();
    expect(headOf(container, "CP-A")).toBeTruthy();
    expect(counter(container)).toBe("2 CPs · 3 connectors");
  });

  it("the OCPP version select lists the versions present and filters", async () => {
    const { container } = await mount("/");
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="OCPP version"]',
    )!;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Any version",
      "1.6J",
      "2.0.1",
    ]);

    await setValue(select, "2.0.1", "change");

    expect(location?.search).toBe("?version=2.0.1");
    expect(headOf(container, "CP-B")).toBeTruthy();
    expect(container.querySelector('[data-cp-id="CP-A"]')).toBeNull();
  });

  it("the Status and OCPP version selects share one class, the one that draws the chevron", async () => {
    const { container } = await mount("/");
    const status = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Status"]',
    )!;
    const version = container.querySelector<HTMLSelectElement>(
      'select[aria-label="OCPP version"]',
    )!;

    // jsdom paints nothing, so the class is the guard: `cx-select` (index.css)
    // is what draws the chevron, and identical classes mean the same height
    // and padding. The "Any version" select once showed no chevron.
    expect(version.className).toBe(status.className);
    expect(version.classList.contains("cx-select")).toBe(true);
  });

  it("typing in the charge point combobox and pressing Enter sets ?q=", async () => {
    const { container } = await mount("/");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Charge point"]',
    )!;
    expect(input.getAttribute("placeholder")).toBe("Charge point");

    await act(async () => {
      input.focus();
    });
    await setValue(input, "cp-b", "input");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();

    expect(location?.search).toBe("?q=CP-B");
    expect(input.value).toBe("CP-B");
    expect(headOf(container, "CP-B")).toBeTruthy();
    expect(container.querySelector('[data-cp-id="CP-A"]')).toBeNull();
    expect(counter(container)).toBe("1 CPs · 1 connectors");
  });

  /** Focuses a combobox, types into it and returns what its list offers. */
  const optionsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (o) => o.textContent,
    );

  it("the Connector combobox offers #n options and filters on the number", async () => {
    const { container } = await mount("/");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Connector"]',
    )!;
    expect(input.getAttribute("placeholder")).toBe("Connector");
    expect(
      container.querySelector(
        'input[aria-label="Connector number or transaction id"]',
      ),
    ).toBeNull();

    await act(async () => {
      input.focus();
    });
    expect(optionsOf(container)).toEqual(["#1", "#2"]);

    // A typed "#2" is stored as the number only.
    await setValue(input, "#2", "input");
    expect(location?.search).toBe("?conn=2");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#2",
    ]);

    await setValue(input, "1", "input");
    expect(location?.search).toBe("?conn=1");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#1",
      "CP-B#1",
      "CP-C#1",
    ]);
  });

  it("the Transaction combobox offers the active transaction ids and filters on them", async () => {
    const { container } = await mount("/");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Transaction"]',
    )!;
    expect(input.getAttribute("placeholder")).toBe("Transaction");

    await act(async () => {
      input.focus();
    });
    expect(optionsOf(container)).toEqual(["#42CP-A #2"]);

    await setValue(input, "4", "input");
    expect(location?.search).toBe("?tx=4");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#2",
    ]);

    // Picking the suggestion writes the id text, without the "#".
    await act(async () => {
      input.focus();
    });
    await click(
      Array.from(container.querySelectorAll('[role="option"]')).find((o) =>
        o.textContent?.startsWith("#42"),
      )!,
    );
    expect(location?.search).toBe("?tx=42");
    expect(input.value).toBe("42");
    expect(counter(container)).toBe("1 CPs · 1 connectors");
  });

  it("?conn= and ?tx= do not touch the panel's ?connector=, and both filters combine", async () => {
    const { container } = await mount("/?cp=CP-A&connector=1&conn=2&tx=42");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Connector"]',
      )!.value,
    ).toBe("2");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Transaction"]',
      )!.value,
    ).toBe("42");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#2",
    ]);
    expect(location?.search).toBe("?cp=CP-A&connector=1&conn=2&tx=42");
  });

  it("a connector with an active scenario run shows it, and the Scenario checkbox keeps only those", async () => {
    const { container } = await mount("/", [cpA, cpB, cpC], {
      // Only CP-A's connector 2 runs a scenario.
      listScenarios: vi.fn(async (cpId: string, connectorId: number) =>
        cpId === "CP-A" && connectorId === 2
          ? [{ scenarioId: "s1", name: "Morning rush", active: true }]
          : [],
      ),
      getScenarioStatus: vi.fn(async () => ({
        runId: "r1",
        state: "running",
        executedNodes: [],
      })),
      getScenario: vi.fn(async () => ({ nodes: [] })),
    } as never);

    const cell = cellOf(container, "CP-A#2");
    expect(cell.title).toContain("running: Morning rush");
    expect(cell.querySelector("svg.lucide-play")).toBeTruthy();
    expect(
      cellOf(container, "CP-A#1").querySelector("svg.lucide-play"),
    ).toBeNull();
    expect(headOf(container, "CP-A").textContent).toContain("Scenario");
    expect(headOf(container, "CP-B").textContent).not.toContain("Scenario");

    const checkbox = Array.from(
      container.querySelectorAll<HTMLLabelElement>("label"),
    )
      .find((l) => l.textContent?.trim() === "Scenario")!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(checkbox);

    expect(location?.search).toBe("?scenario=1");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-A#2",
    ]);
    expect(counter(container)).toBe("1 CPs · 1 connectors");
  });

  it("the Scenario checkbox leaves nothing when no run is active", async () => {
    const { container } = await mount("/?scenario=1");
    expect(counter(container)).toBe("0 CPs · 0 connectors");
    expect(container.textContent).toContain(
      "No charge points match the current filters.",
    );
  });

  it("filters survive opening the panel, and the panel survives a filter change", async () => {
    const { container } = await mount("/?status=Available&view=cp");

    await click(buttonByText(container, "CP-B")!);
    expect(location?.search).toBe("?status=Available&view=cp&cp=CP-B");

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Status"]',
    )!;
    await setValue(select, "", "change");
    expect(location?.search).toBe("?view=cp&cp=CP-B");
  });

  it("a table row click opens the panel (?cp=) and highlights the row", async () => {
    const { container } = await mount("/?view=cp");
    const row = container.querySelector<HTMLElement>('tr[data-cp-id="CP-B"]')!;

    await click(row);

    expect(location?.search).toBe("?view=cp&cp=CP-B");
    expect(
      container.querySelector('aside[aria-label="Charge point"] h2')
        ?.textContent,
    ).toBe("CP-B");
    expect(row.getAttribute("data-selected")).toBe("true");
  });

  it("a connector row opens the panel on that connector", async () => {
    const { container } = await mount("/?view=connectors");
    const row = Array.from(container.querySelectorAll("tbody tr")).find((r) =>
      r.textContent?.includes("CP-A #2"),
    )!;

    await click(row);

    expect(location?.search).toBe("?view=connectors&cp=CP-A&connector=2");
  });

  it("a connector cell opens the panel on that connector and shows it pressed", async () => {
    const { container } = await mount("/");
    const cell = cellOf(container, "CP-A#2");
    expect(cell.getAttribute("aria-pressed")).toBe("false");

    await click(cell);

    expect(location?.search).toBe("?cp=CP-A&connector=2");
    expect(cellOf(container, "CP-A#2").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(cellOf(container, "CP-A#1").getAttribute("aria-pressed")).toBe(
      "false",
    );

    // Clicking the open one again closes the panel.
    await click(cellOf(container, "CP-A#2"));
    expect(location?.search).toBe("");
  });

  it("the twist collapses and expands the connector grid of one charge point", async () => {
    const { container } = await mount("/");
    const twist = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse connectors of CP-A"]',
    )!;
    expect(twist.getAttribute("aria-expanded")).toBe("true");
    expect(cells(container)).toHaveLength(4);

    await click(twist);

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand connectors of CP-A"]',
    )!;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(cells(container).map((c) => c.dataset.connectorCell)).toEqual([
      "CP-B#1",
      "CP-C#1",
    ]);
    // The twist is not a click on the row: the panel stays closed.
    expect(location?.search).toBe("");
    // The dots still tell the connectors' states.
    expect(
      headOf(container, "CP-A").querySelector('[title="#2 Charging"]'),
    ).toBeTruthy();

    await click(expand);
    expect(cells(container)).toHaveLength(4);
  });

  it("a head holds no button but the twist and the id, and tells the heartbeat instead of a power button", async () => {
    const { container } = await mount("/");
    for (const id of ["CP-A", "CP-B", "CP-C"]) {
      const head = headOf(container, id);
      expect(
        Array.from(head.querySelectorAll("button")).map(
          (b) => b.getAttribute("aria-label") ?? b.textContent?.trim(),
        ),
      ).toEqual([`Collapse connectors of ${id}`, id]);
    }
    expect(container.querySelector('[aria-label^="Connect "]')).toBeNull();
    expect(container.querySelector('[aria-label^="Disconnect "]')).toBeNull();

    // Connected charge points tell their last Heartbeat; the disconnected one
    // stays quiet.
    expect(headOf(container, "CP-A").textContent).toContain("heartbeat never");
    expect(headOf(container, "CP-C").textContent).not.toContain("heartbeat");
  });

  it("the Charge points table has no actions column and no power button", async () => {
    const { container } = await mount("/?view=cp");
    const headers = Array.from(container.querySelectorAll("th")).map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toEqual([
      "Charge point",
      "OCPP",
      "Status",
      "In use",
      "Scenario",
      "Heartbeat",
    ]);
    expect(container.querySelector('[aria-label^="Connect "]')).toBeNull();
    expect(container.querySelector('[aria-label^="Disconnect "]')).toBeNull();
  });

  it("keeps today's empty state when there are no charge points at all", async () => {
    const { container } = await mount("/", []);
    expect(container.textContent).toContain("No charge points");
    expect(container.textContent).not.toContain("match the current filters");
    expect(container.querySelector('[data-testid="cp-list-count"]')).toBeNull();
  });
});
