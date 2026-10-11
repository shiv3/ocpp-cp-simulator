// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { VehicleProfile } from "../../cp/domain/vehicle/VehicleProfile";
import { DataContext } from "../../data/providers/DataProvider";
import { createFakeChargePointService } from "../../console/test/harness";
import ScenarioEvSettingsFields from "./ScenarioEvSettingsFields";

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
});

const PROFILE: VehicleProfile = {
  id: "vp_1",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 2,
    dcMaxKw: 200,
    acConnectors: [],
    dcConnectors: [],
  },
  dcCurve: [
    { socPercent: 0, powerKw: 200 },
    { socPercent: 100, powerKw: 50 },
  ],
  overrides: {},
  origin: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

async function render(value: Partial<EVSettings>) {
  const onChange = vi.fn();
  const service = createFakeChargePointService({
    listVehicleProfiles: vi.fn(async () => [PROFILE]),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <DataContext.Provider
        value={{
          mode: "local",
          serverUrl: "",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <ScenarioEvSettingsFields
          value={value}
          onChange={onChange}
          defaultEvSettings={null}
        />
      </DataContext.Provider>,
    ),
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="EV Model preset"]',
  )!;
  return { container, select, onChange };
}

function pick(select: HTMLSelectElement, label: string) {
  const option = Array.from(select.options).find((o) =>
    o.textContent?.startsWith(label),
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!.call(select, option.value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ScenarioEvSettingsFields — saved vehicle profiles (#458)", () => {
  it("copies a profile's DC values into the scenario, keeping its SoCs", async () => {
    const { select, onChange } = await render({ initialSoc: 15 });
    await act(async () => pick(select, "Volkswagen ID.7 GTX · DC"));
    expect(onChange).toHaveBeenCalledWith({
      initialSoc: 15,
      modelName: "Volkswagen ID.7 GTX",
      batteryCapacityKwh: 86,
      maxChargingPowerKw: 200,
      currentType: "DC",
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 100, powerFraction: 0.25 },
      ],
    });
  });

  it("says why an AC phase count is not taken over", async () => {
    const { select, container } = await render({});
    await act(async () => pick(select, "Volkswagen ID.7 GTX · AC"));
    expect(container.textContent).toContain(
      "The source gives 2 AC phases; the simulator models 1 or 3",
    );
  });

  it("shows a model that is not a preset under its own name", async () => {
    const { select } = await render({ modelName: "Volkswagen ID.7 GTX" });
    expect(select.value).toBe("Volkswagen ID.7 GTX");
  });
});
