// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import { defaultEVSettings } from "../../../cp/domain/connector/EVSettings";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

function snapshotWith(
  connector: Partial<ChargePointSnapshot["connectors"][number]>,
): ChargePointSnapshot {
  return {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [
      {
        id: 1,
        status: OCPPStatus.Charging,
        availability: "Operative",
        meterValue: 1000,
        transactionId: 7,
        soc: 40,
        mode: "manual",
        autoResetToAvailable: false,
        autoMeterValueConfig: null,
        // 50 kWh from 20 %: 60 % is 20 kWh delivered.
        evSettings: {
          ...defaultEVSettings,
          batteryCapacityKwh: 50,
          initialSoc: 20,
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
}

async function openDialog(
  connector: Partial<ChargePointSnapshot["connectors"][number]> = {},
  overrides: Partial<ChargePointService> = {},
) {
  const service = createFakeChargePointService({
    snapshots: [snapshotWith(connector)],
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    listScenarios: vi.fn(async () => []),
    getSocMeterSync: vi.fn(async () => true),
    ...overrides,
  });
  const { root } = await renderConsole("/cp/CP-1", { service });
  await flush();
  await click(button("Meter & SoC"));
  return { service, root };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function field(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no field ${label}`);
  return found;
}

function alerts(): string[] {
  return Array.from(document.body.querySelectorAll('[role="alert"]')).map(
    (el) => el.textContent ?? "",
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ConnectorCard: meter value and SoC by hand (#417)", () => {
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
    vi.restoreAllMocks();
  });

  it("opens on the connector's live readings and applies the saved sync preference to it", async () => {
    const setConnectorSocMeterSync = vi.fn(async () => {});
    const { root } = await openDialog({}, { setConnectorSocMeterSync });
    unmount = () => act(() => root.unmount());

    expect(field("Meter value (Wh)").value).toBe("1000");
    expect(field("SoC (%)").value).toBe("40");
    expect(field("Sync SoC and meter").checked).toBe(true);
    expect(setConnectorSocMeterSync).toHaveBeenCalledWith("CP-1", 1, true);
  });

  it("sets the meter value, and sends a MeterValues with it on demand", async () => {
    const calls: string[] = [];
    const setMeterValue = vi.fn(async (_id: string, _c: number, v: number) => {
      calls.push(`set ${v}`);
    });
    const sendMeterValue = vi.fn(async () => {
      calls.push("send");
    });
    const { root } = await openDialog({}, { setMeterValue, sendMeterValue });
    unmount = () => act(() => root.unmount());

    await type(field("Meter value (Wh)"), "2500");
    await click(button("Set"));
    expect(calls).toEqual(["set 2500"]);

    await type(field("Meter value (Wh)"), "3000");
    await click(button("Set and send"));
    expect(calls).toEqual(["set 2500", "set 3000", "send"]);
  });

  it("sends a MeterValues with the current reading", async () => {
    const setMeterValue = vi.fn(async () => {});
    const sendMeterValue = vi.fn(async () => {});
    const { root } = await openDialog({}, { setMeterValue, sendMeterValue });
    unmount = () => act(() => root.unmount());

    await click(button("Send MeterValues"));

    expect(sendMeterValue).toHaveBeenCalledWith("CP-1", 1);
    expect(setMeterValue).not.toHaveBeenCalled();
  });

  it("sets the SoC and, with sync on, the meter value that matches it", async () => {
    const setConnectorSoc = vi.fn(async () => {});
    const setMeterValue = vi.fn(async () => {});
    const { root } = await openDialog({}, { setConnectorSoc, setMeterValue });
    unmount = () => act(() => root.unmount());

    await type(field("SoC (%)"), "60");
    await click(button("Set SoC"));

    expect(setConnectorSoc).toHaveBeenCalledWith("CP-1", 1, 60);
    expect(setMeterValue).toHaveBeenCalledWith("CP-1", 1, 20000);
  });

  it("clears the SoC without touching the meter", async () => {
    const setConnectorSoc = vi.fn(async () => {});
    const setMeterValue = vi.fn(async () => {});
    const { root } = await openDialog({}, { setConnectorSoc, setMeterValue });
    unmount = () => act(() => root.unmount());

    await click(button("Clear SoC"));

    expect(setConnectorSoc).toHaveBeenCalledWith("CP-1", 1, null);
    expect(setMeterValue).not.toHaveBeenCalled();
  });

  it("turns sync off for the connector and saves it, after which the SoC leaves the meter alone", async () => {
    const saveSocMeterSync = vi.fn(async () => {});
    const setConnectorSocMeterSync = vi.fn(async () => {});
    const setMeterValue = vi.fn(async () => {});
    const { root } = await openDialog(
      {},
      { saveSocMeterSync, setConnectorSocMeterSync, setMeterValue },
    );
    unmount = () => act(() => root.unmount());

    await click(field("Sync SoC and meter"));
    expect(saveSocMeterSync).toHaveBeenCalledWith("CP-1", 1, false);
    expect(setConnectorSocMeterSync).toHaveBeenLastCalledWith("CP-1", 1, false);

    await type(field("SoC (%)"), "60");
    await click(button("Set SoC"));
    expect(setMeterValue).not.toHaveBeenCalled();
  });

  it("leaves the meter alone while the sync preference is loading", async () => {
    const setMeterValue = vi.fn(async () => {});
    const { root } = await openDialog(
      {},
      {
        getSocMeterSync: vi.fn(() => new Promise<boolean>(() => {})),
        setMeterValue,
      },
    );
    unmount = () => act(() => root.unmount());

    expect(field("Sync SoC and meter").checked).toBe(false);
    expect(field("Sync SoC and meter").disabled).toBe(true);
    await type(field("SoC (%)"), "60");
    await click(button("Set SoC"));
    expect(setMeterValue).not.toHaveBeenCalled();
  });

  it("treats sync as off while its saved preference cannot be read, until the operator turns it on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setConnectorSocMeterSync = vi.fn(async () => {});
    const saveSocMeterSync = vi.fn(async () => {});
    const setMeterValue = vi.fn(async () => {});
    const { root } = await openDialog(
      {},
      {
        getSocMeterSync: vi.fn(async () => {
          throw new Error("db closed");
        }),
        setConnectorSocMeterSync,
        saveSocMeterSync,
        setMeterValue,
      },
    );
    unmount = () => act(() => root.unmount());

    expect(alerts()).toContain(
      "Sync preference not read (db closed): Set SoC leaves the meter alone until you turn sync on.",
    );
    expect(field("Sync SoC and meter").checked).toBe(false);
    await type(field("SoC (%)"), "60");
    await click(button("Set SoC"));
    expect(setMeterValue).not.toHaveBeenCalled();
    expect(setConnectorSocMeterSync).not.toHaveBeenCalled();

    await click(field("Sync SoC and meter"));
    expect(field("Sync SoC and meter").checked).toBe(true);
    expect(saveSocMeterSync).toHaveBeenCalledWith("CP-1", 1, true);
    expect(setConnectorSocMeterSync).toHaveBeenCalledWith("CP-1", 1, true);
    expect(alerts()).toEqual([]);
    await click(button("Set SoC"));
    expect(setMeterValue).toHaveBeenCalledWith("CP-1", 1, 20000);
  });

  it("says when the sync choice was applied but not saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await openDialog(
      {},
      {
        saveSocMeterSync: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
    );
    unmount = () => act(() => root.unmount());

    await click(field("Sync SoC and meter"));

    expect(alerts()).toEqual(["Sync turned off, but not saved: disk full"]);
  });

  it("says when the connector did not take the sync choice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await openDialog(
      {},
      {
        setConnectorSocMeterSync: vi.fn(async () => {
          throw new Error("unknown connector");
        }),
      },
    );
    unmount = () => act(() => root.unmount());

    expect(alerts()).toEqual([
      "Sync not applied to the connector: unknown connector",
    ]);
  });

  it("cannot sync without a battery capacity", async () => {
    const { root } = await openDialog({
      evSettings: { ...defaultEVSettings, batteryCapacityKwh: 0 },
    });
    unmount = () => act(() => root.unmount());

    expect(field("Sync SoC and meter").disabled).toBe(true);
    expect(field("Sync SoC and meter").checked).toBe(false);
  });

  it("says why a MeterValues could not be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await openDialog(
      {},
      {
        sendMeterValue: vi.fn(async () => {
          throw new Error("not connected");
        }),
      },
    );
    unmount = () => act(() => root.unmount());

    await click(button("Send MeterValues"));

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "not connected",
    );
  });
});
