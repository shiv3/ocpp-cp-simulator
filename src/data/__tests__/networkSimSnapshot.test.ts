import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { resolveNetworkSimConfig } from "../../cp/infrastructure/transport/network-sim/config";
import { LocalChargePointService } from "../local/LocalChargePointService";
import type { LocalChargePointDefinition } from "../local/LocalChargePointService";

// Task 22: a ChargePoint exposes a networkSim summary { enabled, manualRuleIds }
// (null for SOAP), and every ChargePointSnapshot it appears in carries it.

function definition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-SNAP",
    connectorNumber: 1,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-1.6J",
    ...overrides,
  };
}

async function buildService(store = createStore()) {
  // These CPs never connect (no socket opened), so no controller timers are
  // armed and no teardown is required between tests.
  const service = new LocalChargePointService(null, store);
  await service.syncLocalChargePoints([definition()]);
  const cp = service.getLocalChargePoint("CP-SNAP") as ChargePoint;
  return { service, cp };
}

describe("networkSim summary on ChargePoint + snapshot", () => {
  it("reports enabled + manual rule ids from an applied resolved config", async () => {
    const { cp } = await buildService();
    const resolved = resolveNetworkSimConfig(
      {
        enabled: true,
        seed: 1,
        rules: {
          "manual-x": { type: "manual-disconnect", reconnectDelayMs: 1000 },
          lat: { type: "latency", delayMs: 100 },
        },
      },
      null,
      "CP-SNAP",
    );
    cp.setNetworkSimConfig(resolved);

    expect(cp.networkSimSummary()).toEqual({
      enabled: true,
      manualRuleIds: ["manual-x"],
    });
  });

  it("reports disabled with no manual rules when the config is disabled", async () => {
    const { cp } = await buildService();
    cp.setNetworkSimConfig(resolveNetworkSimConfig(null, null, "CP-SNAP"));
    expect(cp.networkSimSummary()).toEqual({
      enabled: false,
      manualRuleIds: [],
    });
  });

  it("carries the summary into the ChargePointSnapshot", async () => {
    const { service, cp } = await buildService();
    cp.setNetworkSimConfig(
      resolveNetworkSimConfig(
        {
          enabled: true,
          seed: 3,
          rules: { m: { type: "manual-disconnect", reconnectDelayMs: 500 } },
        },
        null,
        "CP-SNAP",
      ),
    );
    const snapshots = await service.listChargePoints();
    const snap = snapshots.find((s) => s.id === "CP-SNAP");
    expect(snap?.networkSim).toEqual({ enabled: true, manualRuleIds: ["m"] });
  });
});
