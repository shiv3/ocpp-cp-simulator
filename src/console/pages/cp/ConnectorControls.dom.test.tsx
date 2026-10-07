// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DataContext } from "@/data/providers/DataProvider";
import {
  createFakeChargePointService,
  flush,
  type FakeChargePointService,
} from "../../test/harness";
import { defaultEVSettings } from "../../../cp/domain/connector/EVSettings";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointService } from "../../../data/interfaces/ChargePointService";
import ConnectorControls from "./ConnectorControls";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderControls(overrides: Partial<ChargePointService> = {}) {
  const service = createFakeChargePointService({
    getSocMeterSync: vi.fn(async () => false),
    ...overrides,
  }) as FakeChargePointService;
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <DataContext.Provider
        value={{
          mode: "remote",
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <ConnectorControls
          id="controls-1"
          cpId="CP-1"
          connectorId={1}
          status={OCPPStatus.Charging}
          availability="Operative"
          meterValue={16_210}
          soc={46}
          evSettings={defaultEVSettings}
        />
      </DataContext.Provider>,
    ),
  );
  return { container, service };
}

const group = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)!;
const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  )!;

function setValue(field: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

describe("ConnectorControls: what a real charger would not do by itself", () => {
  it("has the three groups, under the block's title", async () => {
    const { container } = await renderControls();
    expect(container.textContent).toContain(
      "Simulator controls — what a real charger would not do by itself",
    );
    for (const name of ["Readings", "Status and faults", "Connector"]) {
      expect(group(container, name)).not.toBeNull();
    }
    expect(container.textContent).toContain("Availability: Operative");
  });

  it("Readings: sets and clears the SoC, sets the meter in Wh and sends MeterValues", async () => {
    const { container, service } = await renderControls();
    const readings = group(container, "Readings");
    const soc = readings.querySelector<HTMLInputElement>(
      'input[aria-label="SoC (%)"]',
    )!;
    expect(soc.value).toBe("46");
    await act(async () => setValue(soc, "55"));
    await click(button(readings, "Set"));
    expect(service.setConnectorSoc).toHaveBeenCalledWith("CP-1", 1, 55);

    await click(button(readings, "Clear"));
    expect(service.setConnectorSoc).toHaveBeenLastCalledWith("CP-1", 1, null);

    const meter = readings.querySelector<HTMLInputElement>(
      'input[aria-label="Meter (kWh)"]',
    )!;
    expect(meter.value).toBe("16.21");
    await act(async () => setValue(meter, "20.5"));
    const setMeter = Array.from(readings.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Set",
    )[1];
    await click(setMeter);
    expect(service.setMeterValue).toHaveBeenCalledWith("CP-1", 1, 20_500);

    await click(button(readings, "Send MeterValues now"));
    expect(service.sendMeterValue).toHaveBeenCalledWith("CP-1", 1);
  });

  it("Readings: with sync on, a set SoC also sets the meter that matches it", async () => {
    const { container, service } = await renderControls({
      getSocMeterSync: vi.fn(async () => true),
    });
    const readings = group(container, "Readings");
    await act(async () =>
      setValue(
        readings.querySelector<HTMLInputElement>(
          'input[aria-label="SoC (%)"]',
        )!,
        "40",
      ),
    );
    await click(button(readings, "Set"));
    // 20 % → 40 % of 75 kWh is 15 kWh.
    expect(service.setMeterValue).toHaveBeenCalledWith("CP-1", 1, 15_000);
  });

  it("Status and faults: sends the picked status, and Faulted with its error code", async () => {
    const { container, service } = await renderControls();
    const faults = group(container, "Status and faults");
    await act(async () =>
      setValue(
        faults.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!,
        OCPPStatus.Unavailable,
      ),
    );
    await click(button(faults, "Send status"));
    expect(service.sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Unavailable,
    );

    const code = faults.querySelector<HTMLSelectElement>(
      'select[aria-label="Fault error code"]',
    )!;
    expect(code.value).toBe("InternalError");
    expect(Array.from(code.options).map((o) => o.value)).not.toContain(
      "NoError",
    );
    await act(async () => setValue(code, "GroundFailure"));
    await click(button(faults, "Send Faulted"));
    expect(service.sendStatusNotification).toHaveBeenLastCalledWith(
      "CP-1",
      1,
      OCPPStatus.Faulted,
      { errorCode: "GroundFailure" },
    );
  });

  it("Connector: plug in and unplug report Preparing and Available", async () => {
    const { container, service } = await renderControls();
    const connector = group(container, "Connector");
    await click(button(connector, "Plug in"));
    expect(service.sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Preparing,
    );
    await click(button(connector, "Unplug"));
    expect(service.sendStatusNotification).toHaveBeenLastCalledWith(
      "CP-1",
      1,
      OCPPStatus.Available,
    );
  });

  it("Connector: Remove asks first", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, service } = await renderControls();
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove connector 1"]',
    )!;
    await click(remove);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Remove connector 1 from CP-1?"),
    );
    expect(service.removeConnector).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await click(remove);
    expect(service.removeConnector).toHaveBeenCalledWith("CP-1", 1);
  });

  it("shows a failed call in its own group", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await renderControls({
      sendMeterValue: vi.fn(async () => {
        throw new Error("not connected");
      }),
    });
    await click(button(group(container, "Readings"), "Send MeterValues now"));
    expect(
      group(container, "Readings").querySelector('[role="alert"]')?.textContent,
    ).toBe("not connected");
    expect(
      group(container, "Connector").querySelector('[role="alert"]'),
    ).toBeNull();
  });
});
