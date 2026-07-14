// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type { StateHistoryEntry } from "../../../cp/application/services/types/StateSnapshot";
import { useCpConfigActions } from "../dashboard/useCpConfigActions";

// `handleSaveConfig`'s catch is only reachable if `updateCp` itself rejects.
// The real `useCpConfigActions.updateCp` never does (both its local/remote
// branches swallow errors internally and always resolve — see its own
// "the returned promise always resolves" doc comment), so this module is
// mocked to force a rejection for that one test; every other test gets a
// harmless no-op default so `useCpConfigActions()`'s unconditional call in
// `CpDetailPage` keeps working normally.
vi.mock("../dashboard/useCpConfigActions", () => ({
  useCpConfigActions: vi.fn(() => ({
    addCp: vi.fn(async () => {}),
    updateCp: vi.fn(async () => {}),
    removeCp: vi.fn(async () => {}),
  })),
}));

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

/** Flushes pending microtasks (e.g. `getChargePoint()`/`getStateHistory()`
 *  promise chains queued from a hook's mount effect) across a couple of
 *  ticks — one `await Promise.resolve()` doesn't always cover a promise
 *  chain with more than one `.then()` hop. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

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

const txEntryFixture: StateHistoryEntry = {
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

describe("CpDetailPage", () => {
  let cleanup: (() => Promise<void>) | null = null;

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
  });

  it("shows the CP header, a disabled Start transaction with no tags, and the fixture's transaction history on tab switch", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [
        connector({ id: 1, status: OCPPStatus.Available }),
        connector({
          id: 2,
          status: OCPPStatus.Charging,
          transactionId: 7,
          transactionTagId: "TAG-7",
        }),
      ],
    });

    const getStateHistory = vi.fn(async () => [txEntryFixture]);
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory,
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    // Header: cpId shown (mono h1), status pill for the CP-level status.
    expect(container.textContent).toContain("CP-1");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("CP-1");

    // Connector 1 card: no transaction, no global tag ids configured (fresh
    // jsdom localStorage) — the tag select is empty and Start transaction is
    // disabled by the tag-flow, not by the button being unconditionally off.
    const connector1Card = container.querySelector('[data-connector-id="1"]');
    expect(connector1Card, "expected a card for connector 1").toBeTruthy();
    const startButton = Array.from(
      connector1Card!.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Start transaction");
    expect(startButton, "expected a Start transaction button").toBeTruthy();
    expect(startButton!.disabled).toBe(true);

    // Connector 2 card: already has an active transaction — Stop transaction
    // instead, with the Tx chip visible.
    const connector2Card = container.querySelector('[data-connector-id="2"]');
    expect(connector2Card!.textContent).toContain("Tx #7");
    expect(connector2Card!.textContent).toContain("TAG-7");
    const stopButton = Array.from(
      connector2Card!.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Stop transaction");
    expect(stopButton, "expected a Stop transaction button").toBeTruthy();

    // Switch to the Transactions tab and see the fixture row rendered from
    // useStateHistory's fetched history.
    const transactionsTrigger = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((el) => el.textContent?.trim() === "Transactions");
    expect(transactionsTrigger, "expected a Transactions tab").toBeTruthy();

    await act(async () => {
      transactionsTrigger!.click();
      await Promise.resolve();
    });
    await flush();

    expect(getStateHistory).toHaveBeenCalledWith("CP-1", {
      transitionType: "transaction",
    });
    expect(container.textContent).toContain("Available → Preparing");

    // A real service call: toggling Stop transaction on connector 2 wires
    // through to chargePointService.stopTransaction.
    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });

    expect(service.stopTransaction).toHaveBeenCalledWith("CP-1", 2);
  });

  it("ConnectorCard: a rejecting stopTransaction is caught, isPending resets, and the failure is logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [
        connector({
          id: 1,
          status: OCPPStatus.Charging,
          transactionId: 9,
        }),
      ],
    });
    const stopTransaction = vi.fn(async () => {
      throw new Error("stop boom");
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      stopTransaction,
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const card = container.querySelector('[data-connector-id="1"]');
    expect(card, "expected a card for connector 1").toBeTruthy();
    const stopButton = Array.from(card!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Stop transaction",
    );
    expect(stopButton, "expected a Stop transaction button").toBeTruthy();

    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(stopTransaction).toHaveBeenCalledWith("CP-1", 1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop transaction on CP-1/1"),
      expect.any(Error),
    );
    // isPending reset in `finally` — the button isn't stuck disabled after
    // the rejection settles.
    expect(stopButton!.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("ConnectorCard: the status dropdown ignores a second status click while the first call is still pending", async () => {
    const cp = snapshot({
      id: "CP-1",
      connectors: [connector({ id: 1 })],
    });
    let resolveStatus: (() => void) | null = null;
    const sendStatusNotification = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const service = createFakeChargePointService({
      snapshots: [cp],
      sendStatusNotification,
      getStateHistory: vi.fn(async () => []),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const card = container.querySelector('[data-connector-id="1"]');
    expect(card, "expected a card for connector 1").toBeTruthy();
    const trigger = Array.from(card!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Set status"),
    );
    expect(trigger, "expected a Set status trigger").toBeTruthy();

    const openDropdown = async () => {
      await act(async () => {
        trigger!.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        await Promise.resolve();
      });
    };
    const findMenuItem = (label: string) =>
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((el) => el.textContent?.trim() === label);

    await openDropdown();
    const firstItem = findMenuItem(OCPPStatus.Charging);
    expect(firstItem, "expected a Charging status item").toBeTruthy();
    await act(async () => {
      firstItem!.click();
      await Promise.resolve();
    });

    expect(sendStatusNotification).toHaveBeenCalledTimes(1);
    expect(sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Charging,
    );

    // Re-open while the first call is still pending and try a second,
    // different status — the pending guard must drop this click.
    await openDropdown();
    const secondItem = findMenuItem(OCPPStatus.Faulted);
    expect(secondItem, "expected a Faulted status item").toBeTruthy();
    await act(async () => {
      secondItem!.click();
      await Promise.resolve();
    });

    expect(sendStatusNotification).toHaveBeenCalledTimes(1);

    // The second click's item was disabled (isPending), so Radix's own
    // onSelect-driven close never ran — the menu is still open. Resolving
    // the in-flight call resets isPending (re-enabling the still-open
    // menu's items), so a subsequent status change goes through normally
    // without needing to reopen the dropdown.
    await act(async () => {
      resolveStatus?.();
      await Promise.resolve();
    });
    await flush();

    const thirdItem = findMenuItem(OCPPStatus.Faulted);
    expect(thirdItem, "expected a Faulted status item").toBeTruthy();
    await act(async () => {
      thirdItem!.click();
      await Promise.resolve();
    });

    expect(sendStatusNotification).toHaveBeenCalledTimes(2);
  });

  it("CpDetailPage: a rejecting disconnect is caught, isConnectPending resets, and the failure is logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const disconnect = vi.fn(async () => {
      throw new Error("disconnect boom");
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      disconnect,
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const disconnectButton = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Disconnect");
    expect(disconnectButton, "expected a Disconnect button").toBeTruthy();

    await act(async () => {
      disconnectButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(disconnect).toHaveBeenCalledWith("CP-1");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to disconnect CP-1"),
      expect.any(Error),
    );
    // isConnectPending reset in `finally` — the button isn't stuck disabled.
    expect(disconnectButton!.disabled).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("CpDetailPage: a rejecting updateCp is caught by handleSaveConfig and logged (not an unhandled rejection)", async () => {
    const cp = snapshot({
      id: "CP-1",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1 })],
    });
    const service = createFakeChargePointService({
      snapshots: [cp],
      getStateHistory: vi.fn(async () => []),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const updateCp = vi.fn(async () => {
      throw new Error("save boom");
    });
    vi.mocked(useCpConfigActions).mockReturnValue({
      addCp: vi.fn(async () => {}),
      updateCp,
      removeCp: vi.fn(async () => {}),
    });

    const { container, root } = await renderConsole("/cp/CP-1", { service });
    cleanup = () => unmount(root);
    await flush();

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Edit config",
    );
    expect(editButton, "expected an Edit config button").toBeTruthy();
    await act(async () => {
      editButton!.click();
      await Promise.resolve();
    });

    const saveButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Save");
    expect(saveButton, "expected a Save button in the edit modal").toBeTruthy();

    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });
    await flush();

    expect(updateCp).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save config for CP-1"),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });
});
