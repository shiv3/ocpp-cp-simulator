// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";

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

const cpSeven: ChargePointSnapshot = {
  id: "CP-7",
  status: OCPPStatus.Available,
  error: "",
  connectors: [1, 2, 3, 4, 5, 6, 7].map(connector),
};

describe("CpDetailContent: the connector grid on the full page", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    vi.restoreAllMocks();
  });

  it("lays the connectors out two per row from 1100 px, one below", async () => {
    const service = createFakeChargePointService({
      snapshots: [cpSeven],
      getStateHistory: vi.fn(async () => []),
      listScenarios: vi.fn(async () => []),
      getNetworkSimGlobal: vi.fn(async () => null),
      getNetworkSimCp: vi.fn(async () => ({
        config: null,
        resolved: {} as never,
      })),
    });
    const { container, root } = await renderConsole("/cp/CP-7", { service });
    cleanup = async () => {
      await act(async () => {
        (root as Root).unmount();
      });
      document.body.innerHTML = "";
    };
    await flush();

    const grid = container.querySelector<HTMLElement>(
      '[data-testid="connector-grid"]',
    );
    expect(grid, "expected the connector grid").toBeTruthy();
    expect(grid!.querySelectorAll("[data-connector-id]")).toHaveLength(7);
    // jsdom does not lay out: assert the rule, not the geometry. Two columns
    // from 1100 px of content width, one below; no horizontal scrolling.
    expect(grid!.className).toContain("@min-[1100px]:grid-cols-2");
    expect(grid!.className).toContain("grid-cols-1");
    expect(grid!.className).not.toContain("overflow-x-auto");
    expect(grid!.style.gridAutoColumns).toBe("");
    expect(grid!.getAttribute("role")).toBeNull();
  });
});
