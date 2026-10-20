// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { buildSampledValues } from "../../../cp/domain/connector/MeterValueBuilder";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../cp/domain/types/OcppTypes";
import type { VehicleProfile } from "../../../cp/domain/vehicle/VehicleProfile";
import { LocalChargePointService } from "../../../data/local/LocalChargePointService";
import { DataContext } from "../../../data/providers/DataProvider";
import ConnectorConfigDialog from "./ConnectorConfigDialog";

/**
 * #458 review: a vehicle picked in the Config dialog replaces the previous
 * one — after a save and a reopen too, when the dialog no longer knows a
 * profile was applied. Driven through a real service and connector, so the
 * merge of the saved settings is the real one.
 */

let root: Root | null = null;
let service: LocalChargePointService | null = null;

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
  await service?.syncLocalChargePoints([]).catch(() => undefined);
  service = null;
  document.body.innerHTML = "";
});

const ID7: VehicleProfile = {
  id: "vp_id7",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 3,
    dcMaxKw: 200,
    acConnectors: [],
    dcConnectors: [],
  },
  dcCurve: [
    { socPercent: 0, powerKw: 200 },
    { socPercent: 100, powerKw: 20 },
  ],
  overrides: {},
  origin: null,
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
};

async function flush(hops = 6) {
  for (let i = 0; i < hops; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function setup() {
  service = new LocalChargePointService(null);
  await service.syncLocalChargePoints([
    {
      id: "CP-1",
      connectorNumber: 1,
      bootNotification: DefaultBootNotification,
      wsUrl: "ws://127.0.0.1:1/ocpp/",
      basicAuth: null,
      autoMeterValueSetting: null,
      ocppVersion: "OCPP-1.6J",
    },
  ]);
  await service.saveVehicleProfile(ID7);
  const chargePoint = service.getLocalChargePoint("CP-1") as ChargePoint;
  return chargePoint.getConnector(1)!;
}

/** Opens the dialog on the connector's current settings, as the card does. */
async function openDialog(evSettings: ReturnType<typeof Object>) {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
  }
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(
      <DataContext.Provider
        value={{
          mode: "local",
          serverUrl: "",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service!,
        }}
      >
        <ConnectorConfigDialog
          cpId="CP-1"
          connectorId={1}
          open
          onOpenChange={() => {}}
          initialTab="ev"
          status={OCPPStatus.Available}
          evSettings={evSettings}
          liveAutoMeter={null}
        />
      </DataContext.Provider>,
    ),
  );
  await flush();
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

async function pick(dialog: HTMLElement, label: string) {
  const select = dialog.querySelector<HTMLSelectElement>(
    'select[aria-label="Vehicle"]',
  )!;
  const option = Array.from(select.options).find((o) =>
    o.textContent?.startsWith(label),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function save(dialog: HTMLElement) {
  const button = Array.from(dialog.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Save",
  )!;
  await act(async () => button.click());
  await flush();
}

describe("ConnectorConfigDialog replaces the vehicle (#458 review)", () => {
  it("drops a saved profile's curve, current type and phases for a preset", async () => {
    const connector = await setup();

    // Apply the profile for AC and save.
    let dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Volkswagen ID.7 GTX · AC");
    await save(dialog);
    expect(connector.evSettings).toMatchObject({
      currentType: "AC",
      phases: 3,
      chargingCurve: [],
    });
    // Then DC, whose curve tapers.
    dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Volkswagen ID.7 GTX · DC");
    await save(dialog);
    expect(connector.evSettings.chargingCurve).toHaveLength(2);

    // Reopen: the dialog only knows the connector's settings now.
    dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Tesla Model 3");
    await save(dialog);

    const settings = connector.evSettings;
    expect(settings).toMatchObject({
      modelName: "Tesla Model 3",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 250,
    });
    expect("chargingCurve" in settings).toBe(false);
    expect("currentType" in settings).toBe(false);
    expect("phases" in settings).toBe(false);
    expect("attribution" in settings).toBe(false);

    // And it charges like the preset: flat at its maximum, not tapered.
    connector.socMeterSyncEnabled = false;
    connector.status = OCPPStatus.Charging;
    connector.beginTransaction({
      id: 1,
      connectorId: 1,
      tagId: "TAG",
      meterStart: 0,
      meterStop: null,
      startTime: new Date("2026-10-12T00:00:00.000Z"),
      stopTime: null,
      meterSent: false,
    });
    connector.soc = 90;
    const power = buildSampledValues(
      connector,
      ["Power.Active.Import"],
      "Sample.Periodic",
    ).find((s) => s.measurand === "Power.Active.Import")?.value;
    expect(Number(power)).toBe(250_000);
  });

  it("keeps a preset's vehicle when Custom is picked after it", async () => {
    const connector = await setup();
    let dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Volkswagen ID.7 GTX · DC");
    await save(dialog);
    dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Tesla Model 3");
    await pick(dialog, "Custom");
    await save(dialog);
    const settings = connector.evSettings;
    expect(settings).toMatchObject({
      modelName: "Custom",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 250,
    });
    expect("chargingCurve" in settings).toBe(false);
    expect("currentType" in settings).toBe(false);
    expect("phases" in settings).toBe(false);
  });

  it("keeps a profile's vehicle when Custom is picked after it", async () => {
    const connector = await setup();
    const dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Volkswagen ID.7 GTX · DC");
    await pick(dialog, "Custom");
    await save(dialog);
    expect(connector.evSettings.currentType).toBe("DC");
    expect(connector.evSettings.chargingCurve).toHaveLength(2);
  });

  it("keeps the current vehicle's fields for Custom", async () => {
    const connector = await setup();
    let dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Volkswagen ID.7 GTX · DC");
    await save(dialog);
    dialog = await openDialog(connector.evSettings);
    await pick(dialog, "Custom");
    await save(dialog);
    expect(connector.evSettings.modelName).toBe("Custom");
    expect(connector.evSettings.currentType).toBe("DC");
    expect(connector.evSettings.chargingCurve).toHaveLength(2);
  });
});
