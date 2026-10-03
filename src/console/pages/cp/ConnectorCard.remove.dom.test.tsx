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
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../../data/interfaces/ChargePointService";

function connector(id: number): ChargePointSnapshot["connectors"][number] {
  return {
    id,
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
  };
}

const CP: ChargePointSnapshot = {
  id: "CP-1",
  status: OCPPStatus.Available,
  error: "",
  connectors: [connector(1), connector(2)],
};

async function renderCpPage(overrides: Partial<ChargePointService>) {
  const service = createFakeChargePointService({
    snapshots: [CP],
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
  return { service, root };
}

function card(id: number): HTMLElement | null {
  return document.body.querySelector(`[data-connector-id="${id}"]`);
}

async function clickRemove(id: number): Promise<void> {
  const button = card(id)?.querySelector<HTMLButtonElement>(
    `button[aria-label="Remove connector ${id}"]`,
  );
  if (!button) throw new Error(`no remove button on connector ${id}`);
  await act(async () => {
    button.click();
  });
  await flush();
}

describe("ConnectorCard: remove a connector (#419)", () => {
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

  it("asks first, removes the connector, and drops its card once the charge point reports it", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const removeConnector = vi.fn(async () => {});
    const { service, root } = await renderCpPage({ removeConnector });
    unmount = () => act(() => root.unmount());

    await clickRemove(2);

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Remove connector 2 from CP-1?"),
    );
    expect(removeConnector).toHaveBeenCalledWith("CP-1", 2);

    await pushEvent(service as FakeChargePointService, "CP-1", {
      type: "connector-removed",
      connectorId: 2,
    });
    expect(card(2)).toBeNull();
    expect(card(1)).not.toBeNull();
  });

  it("keeps the connector when the confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const removeConnector = vi.fn(async () => {});
    const { root } = await renderCpPage({ removeConnector });
    unmount = () => act(() => root.unmount());

    await clickRemove(2);

    expect(removeConnector).not.toHaveBeenCalled();
  });

  it("says why the connector was not removed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await renderCpPage({
      removeConnector: vi.fn(async () => {
        throw new Error("unknown connector");
      }),
    });
    unmount = () => act(() => root.unmount());

    await clickRemove(2);

    expect(card(2)?.querySelector('[role="alert"]')?.textContent).toBe(
      "Connector not removed: unknown connector",
    );
  });
});
