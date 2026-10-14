// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  findMenuItem,
  flush,
  openDropdownMenu,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

const CP: ChargePointSnapshot = {
  id: "CP-1",
  status: OCPPStatus.Available,
  error: "",
  connectors: [
    {
      id: 1,
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
    },
  ],
};

async function renderCpPage() {
  const sendStatusNotification = vi.fn(async () => {});
  const service = createFakeChargePointService({
    snapshots: [CP],
    sendStatusNotification,
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
  return { root, sendStatusNotification };
}

function card(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    '[data-connector-id="1"]',
  );
  if (!found) throw new Error("no card for connector 1");
  return found;
}

function faultCodeSelect(): HTMLSelectElement {
  const found = card().querySelector<HTMLSelectElement>(
    'select[aria-label="Fault error code"]',
  );
  if (!found) throw new Error("no Fault error code select");
  return found;
}

async function setStatus(status: OCPPStatus): Promise<void> {
  const trigger = Array.from(card().querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Set status"),
  );
  if (!trigger) throw new Error("no Set status trigger");
  await openDropdownMenu(trigger);
  const item = findMenuItem(status);
  if (!item) throw new Error(`no ${status} item`);
  await act(async () => {
    item.click();
  });
  await flush();
}

describe("ConnectorCard: the error code of a Faulted status (#434)", () => {
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

  it("sends Faulted with the chosen error code", async () => {
    const { root, sendStatusNotification } = await renderCpPage();
    unmount = () => act(() => root.unmount());

    await act(async () => {
      faultCodeSelect().value = "GroundFailure";
      faultCodeSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await setStatus(OCPPStatus.Faulted);

    expect(sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Faulted,
      { errorCode: "GroundFailure" },
    );
  });

  it("defaults to InternalError, and offers no NoError for a fault", async () => {
    const { root, sendStatusNotification } = await renderCpPage();
    unmount = () => act(() => root.unmount());

    const codes = Array.from(faultCodeSelect().options).map((o) => o.value);
    expect(codes).toContain("GroundFailure");
    expect(codes).not.toContain("NoError");

    await setStatus(OCPPStatus.Faulted);
    expect(sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Faulted,
      { errorCode: "InternalError" },
    );
  });

  it("sends any other status without an error code", async () => {
    const { root, sendStatusNotification } = await renderCpPage();
    unmount = () => act(() => root.unmount());

    await setStatus(OCPPStatus.Unavailable);

    expect(sendStatusNotification).toHaveBeenCalledWith(
      "CP-1",
      1,
      OCPPStatus.Unavailable,
    );
  });
});
