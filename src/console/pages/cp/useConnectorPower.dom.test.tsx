// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DataContext } from "@/data/providers/DataProvider";
import {
  createFakeChargePointService,
  flush,
  pushEvent,
  type FakeChargePointService,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import {
  clearConnectorPowerCache,
  useConnectorPower,
  type ConnectorPower,
} from "./useConnectorPower";

let root: Root | null = null;
let clock = 0;

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
  clearConnectorPowerCache();
  vi.restoreAllMocks();
});

function snapshot(transactionId: number | null, meterValue: number) {
  const cp: ChargePointSnapshot = {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [
      {
        id: 1,
        status: transactionId ? OCPPStatus.Charging : OCPPStatus.Available,
        availability: "Operative",
        meterValue,
        transactionId,
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
      },
    ],
  };
  return cp;
}

async function renderHook(service: FakeChargePointService) {
  const seen: { current: ConnectorPower | null } = { current: null };
  const Probe = () => {
    seen.current = useConnectorPower("CP-1", 1);
    return null;
  };
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
        <Probe />
      </DataContext.Provider>,
    ),
  );
  await flush();
  return seen;
}

describe("useConnectorPower: power from the meter readings of a transaction", () => {
  it("is the slope of the last two meter readings", async () => {
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const service = createFakeChargePointService({
      snapshots: [snapshot(7, 12_790)],
    });
    const seen = await renderHook(service);

    expect(seen.current?.samples).toEqual([{ t: 1_000_000, wh: 12_790 }]);
    expect(seen.current?.startWh).toBe(12_790);
    expect(seen.current?.powerKw).toBe(0);

    clock += 10_000;
    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 1,
      meterValue: 12_810,
    });
    // 20 Wh in 10 s is 7.2 kW.
    expect(seen.current?.powerKw).toBeCloseTo(7.2, 6);

    clock += 10_000;
    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 1,
      meterValue: 12_840,
    });
    expect(seen.current?.powerKw).toBeCloseTo(10.8, 6);
    expect(seen.current?.samples).toHaveLength(3);
  });

  it("ignores another connector's readings", async () => {
    clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const service = createFakeChargePointService({
      snapshots: [snapshot(7, 1000)],
    });
    const seen = await renderHook(service);
    clock += 1000;
    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 2,
      meterValue: 5000,
    });
    expect(seen.current?.samples).toHaveLength(1);
  });

  it("starts over on a new transaction, from the meter at its start", async () => {
    clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const service = createFakeChargePointService({
      snapshots: [snapshot(7, 1000)],
    });
    const seen = await renderHook(service);
    clock += 10_000;
    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 1,
      meterValue: 1500,
    });

    clock += 5000;
    await pushEvent(service, "CP-1", {
      type: "connector-transaction",
      connectorId: 1,
      transactionId: null,
    });
    expect(seen.current?.samples).toEqual([]);
    expect(seen.current?.powerKw).toBe(0);
    expect(seen.current?.startWh).toBeNull();

    clock += 5000;
    await pushEvent(service, "CP-1", {
      type: "connector-transaction",
      connectorId: 1,
      transactionId: 8,
    });
    expect(seen.current?.startWh).toBe(1500);
    expect(seen.current?.samples).toEqual([{ t: 20_000, wh: 1500 }]);
  });

  it("records nothing outside a transaction", async () => {
    clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const service = createFakeChargePointService({
      snapshots: [snapshot(null, 1000)],
    });
    const seen = await renderHook(service);
    clock += 1000;
    await pushEvent(service, "CP-1", {
      type: "connector-meter",
      connectorId: 1,
      meterValue: 2000,
    });
    expect(seen.current?.samples).toEqual([]);
  });
});
