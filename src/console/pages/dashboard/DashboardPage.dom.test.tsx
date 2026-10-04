// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "../../../cp/shared/Logger";
import type {
  ChargePointEvent,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function pushEvent(
  service: FakeChargePointService,
  cpId: string,
  event: ChargePointEvent,
): Promise<void> {
  const handlers = service.__handlers.subscribe.get(cpId);
  if (!handlers || handlers.size === 0) {
    throw new Error(`no subscribe handler recorded for ${cpId}`);
  }
  await act(async () => {
    handlers.forEach((handler) => handler(event));
  });
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

describe("DashboardPage", () => {
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

  it("renders registered/connected CPs with connector rows (energy in kWh), an active Tx, and wires Disconnect to the service", async () => {
    const cpA = snapshot({
      id: "CP-A",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1, meterValue: 16208 })],
    });
    const cpB = snapshot({
      id: "CP-B",
      status: OCPPStatus.Charging,
      connectors: [
        connector({
          id: 1,
          status: OCPPStatus.Charging,
          meterValue: 3.2,
          transactionId: 42,
        }),
      ],
    });

    const service = createFakeChargePointService({ snapshots: [cpA, cpB] });
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);

    // useChargePoints (remote mode) only populates its list from registry
    // events pushed via subscribeRegistry — push the initial snapshot the
    // way the daemon would on first subscribe.
    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA, cpB] });
      }
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("CP-A");
    expect(container.textContent).toContain("CP-B");
    expect(container.textContent).toContain("2 registered");
    expect(container.textContent).toContain("Tx #42");

    const cardA = container.querySelector('[data-cp-id="CP-A"]');
    expect(cardA, "expected a card for CP-A").toBeTruthy();
    // The meter value is in Wh (#368).
    expect(cardA!.textContent).toContain("16.21 kWh");
    const disconnectButton = Array.from(cardA!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Disconnect",
    );
    expect(
      disconnectButton,
      "expected a Disconnect button on CP-A's card",
    ).toBeTruthy();

    await act(async () => {
      disconnectButton!.click();
      await Promise.resolve();
    });

    expect(service.disconnect).toHaveBeenCalledWith("CP-A");
  });

  it("shows an empty state with an add action when there are no charge points", async () => {
    const service = createFakeChargePointService({ snapshots: [] });
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);

    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [] });
      }
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No charge points");
    const addButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Add Charge Point"),
    );
    expect(addButtons.length).toBeGreaterThan(0);
  });

  it("shows a Recent activity strip that fills in as global log events arrive (Task 9)", async () => {
    const cpA = snapshot({ id: "CP-A" });
    const service = createFakeChargePointService({ snapshots: [cpA] });
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);

    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpA] });
      }
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Before any log event, the strip is present but empty.
    expect(container.textContent).toContain("Recent activity");
    expect(container.textContent).toContain("No activity yet.");

    const openLogLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open Message Log"),
    );
    expect(openLogLink, "expected an Open Message Log link").toBeTruthy();
    expect(openLogLink!.getAttribute("href")).toBe("/logs");

    await pushEvent(service, "CP-A", {
      type: "log",
      entry: {
        timestamp: new Date(),
        level: LogLevel.INFO,
        type: LogType.OCPP,
        message: "BootNotification accepted",
      },
    });

    expect(container.textContent).not.toContain("No activity yet.");
    expect(container.textContent).toContain("CP-A");
    expect(container.textContent).toContain("BootNotification accepted");
  });

  it("encodes a special-character cpId in the panel's URL and the full-page link, and the full page opens (bug fix)", async () => {
    const specialId = "CP/Special";
    const cpSpecial = snapshot({ id: specialId, connectors: [] });
    const service = createFakeChargePointService({
      snapshots: [cpSpecial],
      // Expanding the panel lands on CpDetailPage, whose Transactions tab
      // renders by default; its `useStateHistory` expects an array back
      // (the generic auto-stub resolves `undefined`), so this is supplied
      // the same way the CpDetailPage.dom.test.tsx fixture does.
      getStateHistory: vi.fn(async () => []),
    });
    const { container, root } = await renderConsole("/", { service });
    cleanup = () => unmount(root);

    await act(async () => {
      for (const handler of service.__handlers.subscribeRegistry) {
        handler({ type: "snapshot", cps: [cpSpecial] });
      }
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const card = container.querySelector(`[data-cp-id="${specialId}"]`);
    expect(card, "expected a card for CP/Special").toBeTruthy();
    // The id opens the side panel; it no longer links to the full page.
    expect(card!.querySelector("a")).toBeNull();
    expect(
      Array.from(card!.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Open",
      ),
    ).toBe(false);

    const idButton = Array.from(card!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === specialId,
    );
    expect(idButton, "expected the cpId button").toBeTruthy();
    await act(async () => {
      idButton!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The expand link's href must be encodeURIComponent'd — an unencoded "/"
    // would otherwise create an extra route segment that /cp/:cpId can't
    // match.
    const expand = container.querySelector('[aria-label="Open as full page"]');
    expect(expand, "expected the panel's expand link").toBeTruthy();
    expect(expand!.getAttribute("href")).toBe("/cp/CP%2FSpecial");

    // End-to-end: clicking through actually lands on this CP's detail page
    // (an unencoded href would instead produce an extra path segment and
    // land on a blank/unmatched route).
    await act(async () => {
      (expand as HTMLElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain(specialId);
  });
});
