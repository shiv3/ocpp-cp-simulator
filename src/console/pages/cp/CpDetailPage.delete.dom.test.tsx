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
import type {
  SimulatorConfigInput,
  WireSimulatorConfig,
} from "../../../protocol";

const CP: ChargePointSnapshot = {
  id: "CP-1",
  status: OCPPStatus.Available,
  error: "",
  connectors: [],
};

const LOCAL_CONFIG: WireSimulatorConfig = {
  wsURL: "ws://localhost:9000/",
  ChargePointID: "CP-1",
  connectorNumber: 1,
  tagID: "123456",
  ocppVersion: "OCPP-1.6J",
  basicAuthSettings: { enabled: false, username: "" },
  autoMeterValueSetting: { enabled: false, interval: 0, value: 0 },
  Experimental: {
    ChargePointIDs: [
      { ChargePointID: "CP-1", ConnectorNumber: 1 },
      { ChargePointID: "CP-2", ConnectorNumber: 2 },
    ],
    TagIDs: ["123456"],
  },
  BootNotification: null,
};

/** A fake service with what the CP page reads on mount, plus `overrides`. */
function cpService(
  overrides: Parameters<typeof createFakeChargePointService>[0],
) {
  return createFakeChargePointService({
    snapshots: [CP],
    getStateHistory: vi.fn(async () => []),
    getNetworkSimGlobal: vi.fn(async () => null),
    getNetworkSimCp: vi.fn(async () => ({
      config: null,
      resolved: {} as never,
    })),
    ...overrides,
  });
}

/** Delete is the last item of the header's More menu. */
async function clickDelete(): Promise<void> {
  const more = document.body.querySelector<HTMLElement>('[aria-label="More"]');
  if (!more) throw new Error("no More button");
  await openDropdownMenu(more);
  const item = findMenuItem("Delete");
  if (!item) throw new Error("no Delete item in the More menu");
  await act(async () => {
    item.click();
  });
  await flush();
}

function pageTitle(): string | undefined {
  return document.body.querySelector("h1")?.textContent?.trim();
}

describe("CpDetailPage: delete the charge point (#415)", () => {
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

  it("Remote: asks for confirmation, removes the charge point on the daemon and goes back to the dashboard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const removeChargePoint = vi.fn(async () => {});
    const service = cpService({
      removeChargePoint,
    });
    const { root } = await renderConsole("/cp/CP-1", { service });
    unmount = () => act(() => root.unmount());

    await clickDelete();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Delete charge point CP-1?"),
    );
    expect(removeChargePoint).toHaveBeenCalledWith("CP-1");
    expect(pageTitle()).toBe("Charge Points");
  });

  it("does nothing when the confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const removeChargePoint = vi.fn(async () => {});
    const service = cpService({
      removeChargePoint,
    });
    const { root } = await renderConsole("/cp/CP-1", { service });
    unmount = () => act(() => root.unmount());

    await clickDelete();

    expect(removeChargePoint).not.toHaveBeenCalled();
    expect(pageTitle()).toBe("CP-1");
  });

  it("Remote: stays on the page and reports the error when the daemon refuses", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = cpService({
      removeChargePoint: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { root } = await renderConsole("/cp/CP-1", { service });
    unmount = () => act(() => root.unmount());

    await clickDelete();

    expect(alert).toHaveBeenCalledWith("Failed to remove CP: boom");
    expect(pageTitle()).toBe("CP-1");
  });

  it("Local: drops only this charge point from the saved configuration", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let stored: WireSimulatorConfig | null = LOCAL_CONFIG;
    const saveConfig = vi.fn(async (next: SimulatorConfigInput | null) => {
      stored = next as unknown as WireSimulatorConfig | null;
    });
    const service = cpService({
      loadConfig: vi.fn(async () => stored),
      saveConfig,
    });
    const { root } = await renderConsole("/cp/CP-1", {
      service,
      mode: "local",
    });
    unmount = () => act(() => root.unmount());

    await clickDelete();

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0][0]?.Experimental?.ChargePointIDs).toEqual([
      { ChargePointID: "CP-2", ConnectorNumber: 2 },
    ]);
    expect(pageTitle()).toBe("Charge Points");
  });

  it("Local: refuses while the configuration is not loaded, instead of saving an empty one", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const saveConfig = vi.fn(async () => {});
    const service = cpService({
      // Never settles: the page is up before the configuration is.
      loadConfig: vi.fn(
        () => new Promise<WireSimulatorConfig | null>(() => {}),
      ),
      saveConfig,
    });
    const { root } = await renderConsole("/cp/CP-1", {
      service,
      mode: "local",
    });
    unmount = () => act(() => root.unmount());

    await clickDelete();

    expect(saveConfig).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Failed to remove CP: Charge point "CP-1" is not in the configuration',
    );
    expect(pageTitle()).toBe("CP-1");
  });
});
