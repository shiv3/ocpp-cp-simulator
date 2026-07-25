import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import type { NetworkSimLayerConfig } from "../../../cp/infrastructure/transport/network-sim/config";
import { networkSimAtom, type NetworkSimStore } from "../../../store/store";
import { LocalChargePointService } from "../LocalChargePointService";
import type { LocalChargePointDefinition } from "../LocalChargePointService";

function localDefinition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-NETSIM",
    connectorNumber: 1,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-1.6J",
    ...overrides,
  };
}

async function serviceWithChargePoint(
  testStore: ReturnType<typeof createStore>,
) {
  const service = new LocalChargePointService(null, testStore);
  await service.syncLocalChargePoints([localDefinition()]);
  const chargePoint = service.getLocalChargePoint("CP-NETSIM") as ChargePoint;
  return { service, chargePoint };
}

let services: LocalChargePointService[] = [];

beforeEach(() => {
  services = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const svc of services) {
    await svc.syncLocalChargePoints([]).catch(() => undefined);
  }
  services = [];
});

describe("NetworkSim local wiring", () => {
  describe("hydration fail-safe", () => {
    it("handles corrupt/invalid atom value gracefully", async () => {
      const testStore = createStore();
      testStore.set(networkSimAtom, null as unknown as NetworkSimStore);

      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      const global = await service.getNetworkSimGlobal();
      expect(global).toBeNull();
    });

    it("handles unsupported version gracefully", async () => {
      const testStore = createStore();
      testStore.set(networkSimAtom, {
        version: 2,
        global: null,
        perCp: {},
      } as unknown as NetworkSimStore);

      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      const global = await service.getNetworkSimGlobal();
      expect(global).toBeNull();
    });

    it("drops invalid layer with a log", async () => {
      const testStore = createStore();
      testStore.set(networkSimAtom, {
        version: 1,
        global: { enabled: "invalid" },
        perCp: {},
      } as unknown as NetworkSimStore);

      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      const global = await service.getNetworkSimGlobal();
      expect(global).toBeNull();
    });
  });

  describe("attach-before-connect", () => {
    it("applies config before restoreConnections/connect", async () => {
      const testStore = createStore();
      const { service, chargePoint } = await serviceWithChargePoint(testStore);
      services.push(service);

      const spy = vi.spyOn(chargePoint, "setNetworkSimConfig");

      await service.syncLocalChargePoints([localDefinition()]);

      expect(spy).toHaveBeenCalled();
    });
  });

  describe("global save re-applies to all live CPs", () => {
    it("applies global config to all live CPs on save", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([
        localDefinition({ id: "CP-1" }),
        localDefinition({ id: "CP-2" }),
      ]);

      const cp1 = service.getLocalChargePoint("CP-1") as ChargePoint;
      const cp2 = service.getLocalChargePoint("CP-2") as ChargePoint;

      const spy1 = vi.spyOn(cp1, "setNetworkSimConfig");
      const spy2 = vi.spyOn(cp2, "setNetworkSimConfig");

      const globalConfig: NetworkSimLayerConfig = {
        enabled: true,
        seed: 123,
        rules: {
          rule1: {
            type: "latency",
            delayMs: 100,
          },
        },
      };

      await service.saveNetworkSimGlobal(globalConfig);

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();

      const call1 = spy1.mock.calls[spy1.mock.calls.length - 1][0];
      const call2 = spy2.mock.calls[spy2.mock.calls.length - 1][0];

      expect(call1.enabled).toBe(true);
      expect(call2.enabled).toBe(true);
    });
  });

  describe("per-CP save to one", () => {
    it("applies per-CP config only to that CP on save", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([
        localDefinition({ id: "CP-1" }),
        localDefinition({ id: "CP-2" }),
      ]);

      const cp1 = service.getLocalChargePoint("CP-1") as ChargePoint;

      const spy1 = vi.spyOn(cp1, "setNetworkSimConfig");

      const cpConfig: NetworkSimLayerConfig = {
        enabled: false,
        rules: {
          rule1: null,
        },
      };

      await service.saveNetworkSimCp("CP-1", cpConfig);

      expect(spy1.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("live re-apply on atom change", () => {
    it("re-applies config to live CPs on atom change", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const cp1 = service.getLocalChargePoint("CP-1") as ChargePoint;
      const spy = vi.spyOn(cp1, "setNetworkSimConfig");

      const initialCallCount = spy.mock.calls.length;

      const newGlobalConfig: NetworkSimLayerConfig = {
        enabled: true,
        seed: 456,
        rules: {
          rule2: {
            type: "latency",
            delayMs: 200,
          },
        },
      };

      testStore.set(networkSimAtom, {
        version: 1,
        global: newGlobalConfig,
        perCp: {},
      });

      expect(spy.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  describe("removing a local CP deletes its perCp entry", () => {
    it("deletes perCp entry when CP is removed", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const cpConfig: NetworkSimLayerConfig = {
        enabled: true,
        rules: {
          rule1: {
            type: "latency",
            delayMs: 100,
          },
        },
      };

      await service.saveNetworkSimCp("CP-1", cpConfig);

      let stored = testStore.get(networkSimAtom);
      expect(stored.perCp["CP-1"]).toBeDefined();

      await service.syncLocalChargePoints([]);

      stored = testStore.get(networkSimAtom);
      expect(stored.perCp["CP-1"]).toBeUndefined();
    });
  });

  describe("reset-all clears the key", () => {
    it("clears networkSim atom on resetAllState", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const globalConfig: NetworkSimLayerConfig = {
        enabled: true,
        seed: 123,
        rules: {},
      };

      await service.saveNetworkSimGlobal(globalConfig);

      const cpConfig: NetworkSimLayerConfig = {
        enabled: false,
        rules: {},
      };

      await service.saveNetworkSimCp("CP-1", cpConfig);

      let stored = testStore.get(networkSimAtom);
      expect(stored.global).toBeDefined();
      expect(stored.perCp["CP-1"]).toBeDefined();

      await service.resetAllState();

      stored = testStore.get(networkSimAtom);
      expect(stored.global).toBeNull();
      expect(Object.keys(stored.perCp).length).toBe(0);

      const global = await service.getNetworkSimGlobal();
      expect(global).toBeNull();
    });
  });

  describe("triggerNetworkSimDisconnect", () => {
    it("forwards to a live CP", async () => {
      const testStore = createStore();
      const { service, chargePoint } = await serviceWithChargePoint(testStore);
      services.push(service);

      const mockResult = { ok: true } as const;
      const spy = vi
        .spyOn(chargePoint, "triggerNetworkSimDisconnect")
        .mockReturnValue(mockResult);

      const result = await service.triggerNetworkSimDisconnect(
        "CP-NETSIM",
        "rule1",
      );

      expect(spy).toHaveBeenCalledWith("rule1");
      expect(result).toEqual(mockResult);
    });

    it("returns not_connected for an unknown id", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      const result = await service.triggerNetworkSimDisconnect(
        "UNKNOWN-CP",
        "rule1",
      );

      expect(result).toEqual({ ok: false, error: "not_connected" });
    });
  });

  describe("validation on save", () => {
    it("rejects invalid global config on save", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const invalidConfig = {
        enabled: true,
      } as unknown as NetworkSimLayerConfig;

      await expect(
        service.saveNetworkSimGlobal(invalidConfig),
      ).rejects.toThrow();
    });

    it("rejects invalid per-CP config on save", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const invalidConfig = {
        enabled: "invalid",
      } as unknown as NetworkSimLayerConfig;

      await expect(
        service.saveNetworkSimCp("CP-1", invalidConfig),
      ).rejects.toThrow();
    });

    it("allows null config to delete entry", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const config: NetworkSimLayerConfig = {
        enabled: true,
        rules: {},
      };

      await service.saveNetworkSimCp("CP-1", config);

      let stored = testStore.get(networkSimAtom);
      expect(stored.perCp["CP-1"]).toBeDefined();

      await service.saveNetworkSimCp("CP-1", null);

      stored = testStore.get(networkSimAtom);
      expect(stored.perCp["CP-1"]).toBeUndefined();
    });
  });

  describe("resolved config resolution", () => {
    it("returns enabled false for CP when CP config overrides", async () => {
      const testStore = createStore();
      const service = new LocalChargePointService(null, testStore);
      services.push(service);

      await service.syncLocalChargePoints([localDefinition({ id: "CP-1" })]);

      const cpConfig: NetworkSimLayerConfig = {
        enabled: false,
        seed: 200,
        rules: {},
      };

      await service.saveNetworkSimCp("CP-1", cpConfig);
      const result = await service.getNetworkSimCp("CP-1");

      expect(result.resolved.enabled).toBe(false);
      expect(result.resolved.seed).toBe(200);
    });
  });
});
