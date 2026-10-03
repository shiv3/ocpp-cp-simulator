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
import type { ActiveChargingProfile } from "../../../cp/domain/connector/Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  OCPPStatus,
} from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

type ConnectorSnapshot = ChargePointSnapshot["connectors"][number];

function profile(
  overrides: Partial<ActiveChargingProfile> & { chargingProfileId: number },
): ActiveChargingProfile {
  return {
    connectorId: 1,
    stackLevel: 0,
    chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
    chargingProfileKind: ChargingProfileKindType.Absolute,
    chargingRateUnit: ChargingRateUnitType.A,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 16, numberPhases: 3 }],
    ...overrides,
  };
}

async function renderCard(connector: Partial<ConnectorSnapshot>) {
  const snapshot: ChargePointSnapshot = {
    id: "CP-1",
    status: OCPPStatus.Available,
    error: "",
    connectors: [
      {
        id: 1,
        status: OCPPStatus.Charging,
        availability: "Operative",
        meterValue: 0,
        transactionId: 7,
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
        ...connector,
      },
    ],
  };
  const service = createFakeChargePointService({
    snapshots: [snapshot],
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    listScenarios: vi.fn(async () => []),
  });
  const { root } = await renderConsole("/cp/CP-1", { service });
  await flush();
  return { service, root };
}

function card(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    '[data-connector-id="1"]',
  );
  if (!found) throw new Error("no connector card");
  return found;
}

function profiles(): HTMLElement {
  const found = card().querySelector<HTMLElement>(
    '[data-testid="charging-profiles"]',
  );
  if (!found) throw new Error("no charging profiles section");
  return found;
}

describe("ConnectorCard: charging profiles and availability (#422)", () => {
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
  });

  it("shows the availability, and follows ChangeAvailability", async () => {
    const { service, root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    expect(
      card().querySelector('[data-testid="availability"]')?.textContent,
    ).toBe("Operative");

    await pushEvent(service as FakeChargePointService, "CP-1", {
      type: "connector-availability",
      connectorId: 1,
      availability: "Inoperative",
    });
    expect(
      card().querySelector('[data-testid="availability"]')?.textContent,
    ).toBe("Inoperative");
  });

  it("says when no charging profile is installed", async () => {
    const { root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    expect(profiles().querySelector("summary")?.textContent).toContain(
      "Charging profiles (0)",
    );
    expect(profiles().textContent).toContain("No charging profile");
  });

  it("lists each profile with its schedule, marking the current one and a paused one", async () => {
    const current = profile({ chargingProfileId: 3, stackLevel: 2 });
    const stored = profile({
      chargingProfileId: 9,
      chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
      chargingRateUnit: ChargingRateUnitType.W,
      chargingSchedulePeriods: [
        { startPeriod: 0, limit: 0 },
        { startPeriod: 600, limit: 7400 },
      ],
    });
    const { root } = await renderCard({
      chargingProfile: current,
      chargingProfiles: [current, stored],
    });
    unmount = () => act(() => root.unmount());

    expect(profiles().querySelector("summary")?.textContent).toContain(
      "Charging profiles (2)",
    );
    const rows = Array.from(
      profiles().querySelectorAll<HTMLElement>("[data-profile-id]"),
    );
    expect(rows.map((r) => r.dataset.profileId)).toEqual(["3", "9"]);
    expect(rows[0].textContent).toContain("Current");
    expect(rows[0].textContent).toContain("TxProfile");
    expect(rows[0].textContent).toContain("Absolute");
    expect(rows[0].textContent).toContain("stack 2");
    expect(rows[0].textContent).toContain("@0s16 A · 3φ");
    expect(rows[1].textContent).toContain("Stored");
    expect(rows[1].textContent).toContain("TxDefaultProfile");
    expect(rows[1].textContent).toContain("@0s0 W");
    expect(rows[1].textContent).toContain("@600s7400 W");
  });

  it("marks a profile whose every period has a zero limit as paused", async () => {
    const paused = profile({
      chargingProfileId: 4,
      chargingSchedulePeriods: [{ startPeriod: 0, limit: 0 }],
    });
    const { root } = await renderCard({
      chargingProfile: paused,
      chargingProfiles: [paused],
    });
    unmount = () => act(() => root.unmount());

    expect(
      profiles().querySelector('[data-profile-id="4"]')?.textContent,
    ).toContain("Paused");
  });

  it("follows SetChargingProfile / ClearChargingProfile", async () => {
    const { service, root } = await renderCard({});
    unmount = () => act(() => root.unmount());

    const added = profile({ chargingProfileId: 5 });
    await pushEvent(service as FakeChargePointService, "CP-1", {
      type: "connector-charging-profiles",
      connectorId: 1,
      profiles: [added],
    });
    expect(profiles().querySelector('[data-profile-id="5"]')).not.toBeNull();

    await pushEvent(service as FakeChargePointService, "CP-1", {
      type: "connector-charging-profiles",
      connectorId: 1,
      profiles: [],
    });
    expect(profiles().querySelector("[data-profile-id]")).toBeNull();
  });
});
