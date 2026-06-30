import { afterEach, describe, expect, it, vi } from "vitest";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { RegistryChargePointService } from "../RegistryChargePointService";

const registries: CPRegistry[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (registries.length > 0) {
    registries.pop()?.shutdownAll();
  }
});

describe("RegistryChargePointService", () => {
  it("delegates registry lane methods and leaves global lane methods as typed stubs", async () => {
    const registry = new CPRegistry(new EventBus(), null);
    registries.push(registry);
    const service = new RegistryChargePointService(registry);

    await service.createChargePoint({
      cpId: "cp-facade",
      wsUrl: "ws://example.test/ocpp",
      connectors: 2,
      vendor: "FacadeVendor",
      model: "FacadeModel",
    });

    expect(registry.has("cp-facade")).toBe(true);
    await expect(service.listChargePoints()).resolves.toEqual([
      expect.objectContaining({
        id: "cp-facade",
        config: expect.objectContaining({
          connectors: 2,
          vendor: "FacadeVendor",
          model: "FacadeModel",
        }),
      }),
    ]);
    await expect(service.getChargePoint("cp-facade")).resolves.toEqual(
      expect.objectContaining({ id: "cp-facade" }),
    );

    await expect(service.resetAllState()).rejects.toThrow(
      "TODO lane A1.3c: resetAllState",
    );
  });

  it("delegates per-CP methods to the registry service and rejects unknown cpIds", async () => {
    const registry = new CPRegistry(new EventBus(), null);
    registries.push(registry);
    const perCp = registry.create(
      {
        cpId: "cp-delegate",
        wsUrl: "ws://example.test/ocpp",
        connectors: 1,
        vendor: "FacadeVendor",
        model: "FacadeModel",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const service = new RegistryChargePointService(registry);
    const statusSpy = vi.spyOn(perCp, "updateConnectorStatus");

    await service.sendStatusNotification("cp-delegate", 1, OCPPStatus.Charging);

    expect(statusSpy).toHaveBeenCalledWith(1, OCPPStatus.Charging, undefined);
    await expect(
      service.sendStatusNotification("missing-cp", 1, OCPPStatus.Available),
    ).rejects.toThrow("cpId not found: missing-cp");
  });

  it("delegates per-CP subscriptions and returns the unsubscribe callback", () => {
    const registry = new CPRegistry(new EventBus(), null);
    registries.push(registry);
    const perCp = registry.create(
      {
        cpId: "cp-subscribe",
        wsUrl: "ws://example.test/ocpp",
        connectors: 1,
        vendor: "FacadeVendor",
        model: "FacadeModel",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const service = new RegistryChargePointService(registry);
    const unsubscribe = vi.fn();
    const onEventSpy = vi.spyOn(perCp, "onEvent").mockReturnValue(unsubscribe);
    const handler = vi.fn();

    expect(service.subscribe("cp-subscribe", handler)).toBe(unsubscribe);
    expect(onEventSpy).toHaveBeenCalledWith(expect.any(Function));
    expect(() => service.subscribe("missing-cp", handler)).toThrow(
      "cpId not found: missing-cp",
    );
  });
});
