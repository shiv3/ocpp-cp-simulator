// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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

  it("renders registered/connected CPs with connector rows, an active Tx, and wires Disconnect to the service", async () => {
    const cpA = snapshot({
      id: "CP-A",
      status: OCPPStatus.Available,
      connectors: [connector({ id: 1, meterValue: 12.5 })],
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
});
