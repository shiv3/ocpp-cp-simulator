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

  it("keeps every connector in one row that scrolls horizontally, four visible at most", async () => {
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
    // jsdom does not lay out: assert the rule, not the geometry.
    const columns = grid!.style.gridAutoColumns;
    expect(columns).toContain("/ 4");
    expect(columns).toContain("400px");
    expect(grid!.style.gridTemplateColumns).toBe("");
    expect(grid!.className).toContain("overflow-x-auto");
    expect(grid!.className).toContain("[grid-auto-flow:column]");
    // The containing block of the cards' absolute bits, so they cannot widen the page.
    expect(grid!.className.split(" ")).toContain("relative");
    // The row scrolls, so it is a focusable region the arrow keys can scroll.
    expect(grid!.getAttribute("role")).toBe("region");
    expect(grid!.getAttribute("aria-label")).toBe("Connectors");
    expect(grid!.tabIndex).toBe(0);
  });
});
