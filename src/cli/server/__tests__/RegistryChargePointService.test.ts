import { afterEach, describe, expect, it } from "vitest";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { RegistryChargePointService } from "../RegistryChargePointService";

const registries: CPRegistry[] = [];

afterEach(() => {
  while (registries.length > 0) {
    registries.pop()?.shutdownAll();
  }
});

describe("RegistryChargePointService", () => {
  it("delegates registry lane methods and leaves later lanes as typed stubs", async () => {
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

    await expect(service.connect("cp-facade")).rejects.toThrow(
      "TODO lane A1.3b: connect",
    );
    await expect(service.resetAllState()).rejects.toThrow(
      "TODO lane A1.3c: resetAllState",
    );
  });
});
