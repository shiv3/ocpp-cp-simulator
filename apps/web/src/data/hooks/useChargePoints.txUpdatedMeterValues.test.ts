import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { WireSimulatorConfig } from "@ocpp-cp-simulator/contracts/events";
import type { LocalChargePointService } from "../local/LocalChargePointService";

/**
 * #550: in browser local mode the shared config's `txUpdatedMeterValues`
 * reaches every local charge point, on creation and on a later change.
 */
function localConfig(
  overrides: Partial<WireSimulatorConfig> = {},
): WireSimulatorConfig {
  return {
    wsURL: "ws://localhost:9000/ocpp/",
    ChargePointID: "CP-550",
    connectorNumber: 1,
    tagID: "TAG",
    ocppVersion: "OCPP-2.0.1",
    basicAuthSettings: { enabled: false, username: "" },
    autoMeterValueSetting: { enabled: false, interval: 30, value: 10 },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "CP-550", ConnectorNumber: 1 }],
      TagIDs: [],
    },
    BootNotification: null,
    ...overrides,
  };
}

// The hook checks `instanceof`, so the service must come from the same module
// instance as the hook's (vi.resetModules gives every test a fresh one).
async function newService(): Promise<LocalChargePointService> {
  const { LocalChargePointService: Service } =
    await import("../local/LocalChargePointService");
  return new Service();
}

function chargePointOf(service: LocalChargePointService, id: string) {
  return (
    service as unknown as {
      getExistingChargePointOrThrow(id: string): ChargePoint;
    }
  ).getExistingChargePointOrThrow(id);
}

describe("useChargePoints local mode txUpdatedMeterValues (#550)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked = false;
  });

  // The mocks (and the hook module cached under them) are set up once per
  // test; later runs only clear the recorded effects and render again.
  let mocked = false;
  const effects: Array<() => void | (() => void)> = [];

  async function runEffect(
    service: LocalChargePointService,
    config: WireSimulatorConfig,
  ) {
    effects.length = 0;
    if (!mocked) {
      mocked = true;
      vi.doMock("react", () => ({
        useState: (initial: unknown) => [initial, () => {}],
        useCallback: (fn: unknown) => fn,
        useEffect: (effect: () => void | (() => void)) => {
          effects.push(effect);
        },
      }));
      vi.doMock("../providers/DataProvider", () => ({
        useDataContext: () => ({ chargePointService: service, mode: "local" }),
      }));
    }
    const { useChargePoints } = await import("./useChargePoints");
    // The hook is driven by hand here: react is mocked, no renderer exists.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useChargePoints(config);
    effects[0]();
    // syncLocalChargePoints resolves on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("passes the option to the charge points and applies a later change", async () => {
    const service = await newService();
    await runEffect(service, localConfig({ txUpdatedMeterValues: true }));
    expect(chargePointOf(service, "CP-550").txUpdatedMeterValues).toBe(true);

    await runEffect(service, localConfig({ txUpdatedMeterValues: false }));
    expect(chargePointOf(service, "CP-550").txUpdatedMeterValues).toBe(false);
  });

  it("leaves it on (#551 default) when the config does not carry it", async () => {
    const service = await newService();
    await runEffect(service, localConfig());
    expect(chargePointOf(service, "CP-550").txUpdatedMeterValues).toBe(true);
  });
});
