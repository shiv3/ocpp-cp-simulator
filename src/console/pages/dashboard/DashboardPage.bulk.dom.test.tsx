// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  findMenuItem,
  flush,
  openDropdownMenu,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

function connector(
  id: number,
  transactionId: number | null = null,
): ChargePointSnapshot["connectors"][number] {
  return {
    id,
    status: transactionId ? OCPPStatus.Charging : OCPPStatus.Available,
    availability: "Operative",
    meterValue: 0,
    transactionId,
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

function cp(id: string, connectors = [connector(1)]): ChargePointSnapshot {
  return { id, status: OCPPStatus.Available, error: "", connectors };
}

const BULK_MENU = "All charge points";

function bulkTrigger(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === BULK_MENU,
  );
}

async function runBulk(label: string): Promise<void> {
  const trigger = bulkTrigger();
  if (!trigger) throw new Error("no bulk menu");
  await openDropdownMenu(trigger);
  const item = findMenuItem(label);
  if (!item) throw new Error(`no menu item ${label}`);
  await act(async () => {
    item.click();
  });
  await flush();
}

function bulkStatus(): string | undefined {
  return document.body
    .querySelector('[data-testid="bulk-result"]')
    ?.textContent?.trim();
}

async function renderDashboard(
  snapshots: ChargePointSnapshot[],
  overrides: Partial<ChargePointService> = {},
) {
  const service = createFakeChargePointService({
    snapshots,
    // The rows' active-scenario badges list each connector's scenarios.
    listScenarios: vi.fn(async () => []),
    ...overrides,
  });
  const { root } = await renderConsole("/", { service });
  // Remote mode lists the charge points the daemon pushes on subscribe.
  await act(async () => {
    for (const handler of service.__handlers.subscribeRegistry) {
      handler({ type: "snapshot", cps: snapshots });
    }
  });
  await flush();
  return { service, root };
}

describe("DashboardPage: bulk actions on every charge point (#416)", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // Remote-mode TagIDs live in localStorage (useGlobalTagIds).
    localStorage.setItem(
      "ocpp-cp.remote.tagIds",
      JSON.stringify(["TAG-A", "TAG-B"]),
    );
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("is offered only with two charge points or more", async () => {
    const { root } = await renderDashboard([cp("CP-1")]);
    unmount = () => act(() => root.unmount());
    expect(bulkTrigger()).toBeUndefined();
  });

  it("connects every charge point and reports the count", async () => {
    const connect = vi.fn(async () => {});
    const { root } = await renderDashboard([cp("CP-1"), cp("CP-2")], {
      connect,
    });
    unmount = () => act(() => root.unmount());

    await runBulk("Connect all");

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith("CP-1");
    expect(connect).toHaveBeenCalledWith("CP-2");
    expect(bulkStatus()).toBe("Connect all: 2 of 2 charge points.");
  });

  it("disconnects and sends a Heartbeat on every charge point, naming the ones that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnect = vi.fn(async () => {});
    const sendHeartbeat = vi.fn(async (id: string) => {
      if (id === "CP-2") throw new Error("not connected");
    });
    const { root } = await renderDashboard([cp("CP-1"), cp("CP-2")], {
      disconnect,
      sendHeartbeat,
    });
    unmount = () => act(() => root.unmount());

    await runBulk("Disconnect all");
    expect(disconnect).toHaveBeenCalledTimes(2);

    await runBulk("Send Heartbeat to all");
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(bulkStatus()).toBe(
      "Send Heartbeat to all: 1 of 2 charge points. Failed: CP-2 (not connected).",
    );
  });

  it("starts a transaction on connector 1 with one TagID per charge point, skipping those left without one", async () => {
    const startTransaction = vi.fn(async () => {});
    const { root } = await renderDashboard(
      [cp("CP-1"), cp("CP-2"), cp("CP-3")],
      { startTransaction },
    );
    unmount = () => act(() => root.unmount());

    await runBulk("Start transaction on all");

    expect(startTransaction.mock.calls).toEqual([
      ["CP-1", 1, "TAG-A"],
      ["CP-2", 1, "TAG-B"],
    ]);
    expect(bulkStatus()).toBe(
      "Start transaction on all: 2 of 3 charge points. Skipped: CP-3 (no TagID left).",
    );
  });

  it("stops the running transactions read from a fresh snapshot, not the dashboard's list", async () => {
    const stopTransaction = vi.fn(async () => {});
    // The dashboard lists idle connectors; by the time the operator clicks,
    // CP-1 connector 2 and CP-2 connector 1 are charging.
    const listed = [cp("CP-1", [connector(1), connector(2)]), cp("CP-2")];
    const fresh = new Map([
      ["CP-1", cp("CP-1", [connector(1), connector(2, 11)])],
      ["CP-2", cp("CP-2", [connector(1, 12)])],
    ]);
    const { root } = await renderDashboard(listed, {
      getChargePoint: vi.fn(async (id: string) => fresh.get(id) ?? null),
      stopTransaction,
    });
    unmount = () => act(() => root.unmount());

    await runBulk("Stop transaction on all");

    expect(stopTransaction.mock.calls.sort()).toEqual([
      ["CP-1", 2],
      ["CP-2", 1],
    ]);
    expect(bulkStatus()).toBe("Stop transaction on all: 2 of 2 charge points.");
  });

  it("skips a charge point with no running transaction when stopping", async () => {
    const stopTransaction = vi.fn(async () => {});
    const { root } = await renderDashboard(
      [cp("CP-1", [connector(1, 7)]), cp("CP-2")],
      { stopTransaction },
    );
    unmount = () => act(() => root.unmount());

    await runBulk("Stop transaction on all");

    expect(stopTransaction.mock.calls).toEqual([["CP-1", 1]]);
    expect(bulkStatus()).toBe(
      "Stop transaction on all: 1 of 2 charge points. Skipped: CP-2 (no transaction).",
    );
  });
});
