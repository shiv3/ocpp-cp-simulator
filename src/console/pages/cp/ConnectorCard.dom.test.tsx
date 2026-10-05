// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  pushEvent,
  renderConsole,
  type FakeChargePointService,
} from "../../test/harness";
import type { AutoMeterValueConfig } from "../../../cp/domain/connector/MeterValueCurve";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";
import { clearConnectorPowerCache } from "./useConnectorPower";

type ConnectorSnapshot = ChargePointSnapshot["connectors"][number];

const AUTO: AutoMeterValueConfig = {
  enabled: false,
  intervalSeconds: 10,
  autoCalculateInterval: false,
  stopAtTargetSoc: true,
  curvePoints: [
    { time: 0, value: 0 },
    { time: 3600, value: 7.4 },
  ],
};

async function renderCard(
  connector: Partial<ConnectorSnapshot>,
  overrides: Partial<ChargePointService> = {},
) {
  const snapshot: ChargePointSnapshot = {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [
      {
        id: 1,
        status: OCPPStatus.Available,
        availability: "Operative",
        meterValue: 12_790,
        transactionId: null,
        soc: 46,
        mode: "manual",
        autoResetToAvailable: false,
        autoMeterValueConfig: AUTO,
        evSettings: {
          modelName: "Tesla Model 3",
          batteryCapacityKwh: 75,
          maxChargingPowerKw: 11,
          initialSoc: 20,
          targetSoc: 80,
        },
        chargingProfile: null,
        chargingProfiles: [],
        transactionStartTime: null,
        transactionTagId: null,
        transactionBatteryCapacityKwh: null,
        ...connector,
      },
    ],
  };
  const service = createFakeChargePointService({
    snapshots: [snapshot],
    getSocMeterSync: vi.fn(async () => false),
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    listScenarios: vi.fn(async () => []),
    ...overrides,
  });
  const { root } = await renderConsole("/cp/CP-1", { service });
  await flush();
  return { service: service as FakeChargePointService, root };
}

function card(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    '[data-connector-id="1"]',
  );
  if (!found) throw new Error("no connector card");
  return found;
}

const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

function figure(label: string): string {
  const dt = Array.from(card().querySelectorAll("dt")).find(
    (d) => d.textContent === label,
  );
  return dt?.nextElementSibling?.textContent ?? "";
}

describe("ConnectorCard: the connector as a charging session", () => {
  let unmount: (() => void) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
    clearConnectorPowerCache();
    vi.restoreAllMocks();
  });

  it("heads the card with the connector, its status and availability, Config and Controls", async () => {
    const { root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    expect(card().textContent).toContain("Connector 1");
    expect(card().textContent).toContain("Available");
    expect(
      card().querySelector('[data-testid="availability"]')?.textContent,
    ).toBe("Operative");
    expect(button(card(), "Config")).toBeTruthy();

    const toggle = card().querySelector<HTMLButtonElement>(
      "button[aria-controls]",
    )!;
    expect(toggle.textContent).toContain("Controls");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const controls = document.getElementById(
      toggle.getAttribute("aria-controls")!,
    )!;
    expect(controls.hidden).toBe(true);

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(controls.hidden).toBe(false);
  });

  it("puts the battery beside the figures from 340 px of card, the drawing above the SoC under 560 px", async () => {
    const { root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    // jsdom does not lay out: assert the container-query rules.
    const hero = card().querySelector('[data-testid="soc-hero"]')!;
    const batteryRoot = hero.parentElement!.parentElement!;
    const grid = batteryRoot.parentElement!;
    expect(grid.className).toContain(
      "@min-[340px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]",
    );
    expect(grid.className).toContain("@min-[340px]:gap-x-4");
    expect(grid.className).toContain("@min-[560px]:grid-cols-");
    expect(batteryRoot.className).toContain("@max-[560px]:flex-col");
    expect(batteryRoot.className).toContain("@max-[560px]:items-start");
  });

  it("Plug in on the stepper reports Preparing", async () => {
    const { root, service } = await renderCard({});
    unmount = () => act(() => root.unmount());

    const next = card().querySelector<HTMLButtonElement>(
      '[data-state="next"]',
    )!;
    expect(next.textContent).toContain("Plug in");
    await click(next);
    expect(service.sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Preparing,
    );
  });

  it("while charging: Stop on the stepper, the figures, the tag and the power line", async () => {
    const start = Date.now() - 12 * 60_000 - 40_000;
    const { root, service } = await renderCard({
      status: OCPPStatus.Charging,
      transactionId: 1552,
      transactionTagId: "TAG001",
      transactionStartTime: new Date(start),
    });
    unmount = () => act(() => root.unmount());

    expect(card().textContent).toContain("Tx #1552 · TAG001");
    expect(figure("Meter")).toContain("12.79 kWh");
    expect(figure("Energy added")).toContain("0.00 kWh");
    expect(figure("Energy added")).toContain("of 75 kWh");
    expect(figure("Session")).toMatch(/12 m 4\d s/);
    expect(figure("Session")).toContain("Tx #1552");
    expect(figure("Power")).toContain("max 11");

    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 1,
      meterValue: 16_210,
    });
    expect(figure("Energy added")).toContain("3.42 kWh");
    expect(figure("Meter")).toContain("16.21 kWh");

    expect(
      card().querySelector('[data-testid="power-sparkline"]')?.textContent,
    ).toContain("Power this session");
    expect(
      card().querySelector('[data-testid="card-footer"]')?.textContent,
    ).toContain("Tag TAG001");

    const stop = card().querySelector<HTMLButtonElement>(
      '[data-state="next"]',
    )!;
    expect(stop.textContent).toContain("Stop charging");
    await click(stop);
    expect(service.stopTransaction).toHaveBeenCalledWith("CP-1", 1);
  });

  it("without a transaction the power line says so", async () => {
    const { root } = await renderCard({});
    unmount = () => act(() => root.unmount());
    expect(
      card().querySelector('[data-testid="power-sparkline"]')?.textContent,
    ).toContain("no transaction");
  });

  it("the auto meter row toggles the connector's auto meter and summarizes it", async () => {
    const { root, service } = await renderCard({});
    unmount = () => act(() => root.unmount());

    expect(card().textContent).toContain(
      "every 10 s · 7.4 kWh over 60 min, peak 7.4 kW, stop at target SoC",
    );
    const toggle = card().querySelector<HTMLInputElement>(
      'input[aria-label="Auto meter values"]',
    )!;
    expect(toggle.checked).toBe(false);
    await click(toggle);
    expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith("CP-1", 1, {
      ...AUTO,
      enabled: true,
    });
  });

  it("Config opens the dialog on EV; Edit curve… on Auto meter", async () => {
    const { root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    await click(button(card(), "Config")!);
    let dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Connector 1 · Config");
    expect(
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("EV");
    await click(button(dialog, "Cancel")!);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await click(button(card(), "Edit curve…")!);
    dialog = document.body.querySelector('[role="dialog"]')!;
    expect(
      dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Auto meter");
  });
});
