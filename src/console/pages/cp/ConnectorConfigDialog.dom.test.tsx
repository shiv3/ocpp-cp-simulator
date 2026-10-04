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
import type { AutoMeterValueConfig } from "../../../cp/domain/connector/MeterValueCurve";
import type { EVSettings } from "../../../cp/domain/connector/EVSettings";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointService } from "../../../data/interfaces/ChargePointService";
import ConnectorConfigDialog, { type ConfigTab } from "./ConnectorConfigDialog";
import { curvePointsToPower } from "./powerCurve";

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

const EV: EVSettings = {
  modelName: "Tesla Model 3",
  batteryCapacityKwh: 75,
  maxChargingPowerKw: 11,
  initialSoc: 20,
  targetSoc: 80,
};

const LIVE: AutoMeterValueConfig = {
  enabled: true,
  intervalSeconds: 15,
  autoCalculateInterval: false,
  stopAtTargetSoc: false,
  curvePoints: [
    { time: 0, value: 0 },
    { time: 1800, value: 3.7 },
  ],
};

async function renderDialog(
  overrides: Partial<ChargePointService> = {},
  props: { tab?: ConfigTab; live?: AutoMeterValueConfig | null } = {},
) {
  const service = createFakeChargePointService({
    getSocMeterSync: vi.fn(async () => true),
    ...overrides,
  });
  const onOpenChange = vi.fn();
  root = createRoot(document.createElement("div"));
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
        <ConnectorConfigDialog
          cpId="CP-1"
          connectorId={1}
          open
          onOpenChange={onOpenChange}
          initialTab={props.tab ?? "ev"}
          status={OCPPStatus.Charging}
          evSettings={EV}
          liveAutoMeter={props.live === undefined ? LIVE : props.live}
        />
      </DataContext.Provider>,
    ),
  );
  await flush();
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  return { service: service as FakeChargePointService, dialog, onOpenChange };
}

const byLabel = <T extends HTMLElement>(root: ParentNode, label: string) =>
  root.querySelector<T>(`[aria-label="${label}"]`)!;
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

async function save(dialog: HTMLElement) {
  await act(async () => button(dialog, "Save").click());
  await flush();
}

describe("ConnectorConfigDialog: EV and auto meter of one connector", () => {
  it("is titled after the connector, with a vertical tab rail", async () => {
    const { dialog } = await renderDialog();
    expect(dialog.textContent).toContain("Connector 1 · Config");
    const rail = dialog.querySelector('[role="tablist"]')!;
    expect(rail.getAttribute("aria-orientation")).toBe("vertical");
    expect(
      Array.from(rail.querySelectorAll('[role="tab"]')).map((t) => [
        t.textContent,
        t.getAttribute("aria-selected"),
      ]),
    ).toEqual([
      ["EV", "true"],
      ["Auto meter", "false"],
    ]);
  });

  it("EV: a preset fills the battery and the power; Save sends the settings", async () => {
    const setEVSettings = vi.fn(async () => {});
    const { dialog, service, onOpenChange } = await renderDialog({
      setEVSettings,
    });
    const vehicle = byLabel<HTMLSelectElement>(dialog, "Vehicle");
    expect(vehicle.value).toBe("Tesla Model 3");

    await act(async () => setValue(vehicle, "Nissan Leaf (40kWh)"));
    expect(byLabel<HTMLInputElement>(dialog, "Battery (kWh)").value).toBe("40");
    expect(byLabel<HTMLInputElement>(dialog, "Max power (kW)").value).toBe(
      "50",
    );
    await act(async () =>
      setValue(byLabel<HTMLInputElement>(dialog, "Target SoC (%)"), "90"),
    );

    await save(dialog);

    expect(setEVSettings).toHaveBeenCalledWith("CP-1", 1, {
      ...EV,
      modelName: "Nissan Leaf (40kWh)",
      batteryCapacityKwh: 40,
      maxChargingPowerKw: 50,
      targetSoc: 90,
    });
    // The auto meter was not touched: nothing rewritten there.
    expect(service.setAutoMeterValueConfig).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("EV: refuses a target outside 0–100 %", async () => {
    const setEVSettings = vi.fn(async () => {});
    const { dialog, onOpenChange } = await renderDialog({ setEVSettings });
    await act(async () =>
      setValue(byLabel<HTMLInputElement>(dialog, "Target SoC (%)"), "140"),
    );
    await save(dialog);
    expect(setEVSettings).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Target SoC",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("EV: the sync switch reads the saved preference and saves the new one", async () => {
    const saveSocMeterSync = vi.fn(async () => {});
    const setConnectorSocMeterSync = vi.fn(async () => {});
    const { dialog } = await renderDialog({
      saveSocMeterSync,
      setConnectorSocMeterSync,
    });
    const sync = byLabel<HTMLInputElement>(dialog, "Sync SoC and meter");
    expect(sync.getAttribute("role")).toBe("switch");
    expect(sync.checked).toBe(true);

    await act(async () => sync.click());
    expect(sync.checked).toBe(false);
    // Staged until Save, like the rest of the dialog.
    expect(saveSocMeterSync).not.toHaveBeenCalled();

    await save(dialog);
    expect(saveSocMeterSync).toHaveBeenCalledWith("CP-1", 1, false);
    expect(setConnectorSocMeterSync).toHaveBeenLastCalledWith("CP-1", 1, false);
  });

  it("Auto meter: opens on the live configuration as power points", async () => {
    const { dialog } = await renderDialog({}, { tab: "auto" });
    expect(byLabel<HTMLInputElement>(dialog, "Enabled").checked).toBe(true);
    expect(byLabel<HTMLInputElement>(dialog, "Interval (s)").value).toBe("15");
    // 3.7 kWh over 30 min is a constant 7.4 kW.
    expect(byLabel<HTMLInputElement>(dialog, "Point 1 kW").value).toBe("7.4");
    expect(byLabel<HTMLInputElement>(dialog, "Point 2 minute").value).toBe(
      "30",
    );
  });

  it("Auto meter: falls back to the saved configuration, and says when it cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getAutoMeterConfig = vi.fn(async () => {
      throw new Error("store offline");
    });
    const { dialog } = await renderDialog(
      { getAutoMeterConfig },
      { tab: "auto", live: null },
    );
    expect(getAutoMeterConfig).toHaveBeenCalledWith("CP-1", 1);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Saved auto meter values not read: store offline",
    );
    expect(dialog.querySelector('[data-testid="curve-svg"]')).toBeNull();
  });

  it("Auto meter: a preset fills the points, and Save applies then stores the curve", async () => {
    const setAutoMeterValueConfig = vi.fn(async () => {});
    const saveAutoMeterConfig = vi.fn(async () => {});
    const { dialog, service } = await renderDialog({
      setAutoMeterValueConfig,
      saveAutoMeterConfig,
    });
    const tab = Array.from(dialog.querySelectorAll('[role="tab"]')).find(
      (t) => t.textContent === "Auto meter",
    ) as HTMLElement;
    await act(async () => tab.click());
    expect(tab.getAttribute("aria-selected")).toBe("true");

    await act(async () => button(dialog, "Ramp and hold").click());
    expect(dialog.querySelectorAll("tr[data-point-row]")).toHaveLength(4);
    await act(async () =>
      setValue(byLabel<HTMLInputElement>(dialog, "Interval (s)"), "30"),
    );
    await act(async () =>
      byLabel<HTMLInputElement>(dialog, "Stop at target SoC").click(),
    );

    await save(dialog);

    expect(setAutoMeterValueConfig).toHaveBeenCalledTimes(1);
    const [cp, connector, config] = setAutoMeterValueConfig.mock
      .calls[0] as unknown as [string, number, AutoMeterValueConfig];
    expect([cp, connector]).toEqual(["CP-1", 1]);
    expect(config).toMatchObject({
      enabled: true,
      intervalSeconds: 30,
      stopAtTargetSoc: true,
      autoCalculateInterval: false,
    });
    expect(curvePointsToPower(config.curvePoints)).toEqual([
      { minute: 0, kw: 0 },
      { minute: 3, kw: 7.4 },
      { minute: 50, kw: 7.4 },
      { minute: 60, kw: 0 },
    ]);
    expect(saveAutoMeterConfig).toHaveBeenCalledWith("CP-1", 1, config);
    // The EV was not touched.
    expect(service.setEVSettings).not.toHaveBeenCalled();
  });

  it("Auto meter: an edit in the points table reaches the saved curve", async () => {
    const setAutoMeterValueConfig = vi.fn(async () => {});
    const { dialog } = await renderDialog(
      { setAutoMeterValueConfig },
      { tab: "auto" },
    );
    const kw = byLabel<HTMLInputElement>(dialog, "Point 2 kW");
    await act(async () => {
      setValue(kw, "3.7");
      kw.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await save(dialog);
    const config = (
      setAutoMeterValueConfig.mock.calls[0] as unknown as [
        string,
        number,
        AutoMeterValueConfig,
      ]
    )[2];
    expect(curvePointsToPower(config.curvePoints)).toEqual([
      { minute: 0, kw: 7.4 },
      { minute: 30, kw: 3.7 },
    ]);
  });

  it("Auto meter: says when the curve was applied but not stored, and stays open", async () => {
    const { dialog, onOpenChange } = await renderDialog(
      {
        saveAutoMeterConfig: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
      { tab: "auto" },
    );
    await act(async () => byLabel<HTMLInputElement>(dialog, "Enabled").click());
    vi.spyOn(console, "error").mockImplementation(() => {});
    await save(dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Auto meter values applied, but not saved: disk full",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
