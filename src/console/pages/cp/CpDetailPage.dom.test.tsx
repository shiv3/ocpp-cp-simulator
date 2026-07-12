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
});
