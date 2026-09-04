import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";
import { createParamsSchema } from "../../../protocol";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { RegistryChargePointService } from "../RegistryChargePointService";
import { SupervisionUrlPool } from "../../../cp/infrastructure/transport/SupervisionUrlPool";

const OCPP_J = {
  cpId: "CP001",
  connectors: 1,
};

describe("multiple supervision URLs (#296)", () => {
  it("accepts a list and keeps wsUrl a single string", () => {
    // Everything downstream — the status snapshot, `charge_points.ws_url`,
    // every log line — expects one string, so the list is kept beside it
    // rather than replacing it.
    const init = parseCreateBody({
      ...OCPP_J,
      wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
    });
    expect(init.wsUrl).toBe("ws://a/ocpp/");
    expect(init.supervisionUrls).toEqual(["ws://a/ocpp/", "ws://b/ocpp/"]);
  });

  it("leaves a single URL with no list at all", () => {
    const init = parseCreateBody({ ...OCPP_J, wsUrl: "ws://a/ocpp/" });
    expect(init.wsUrl).toBe("ws://a/ocpp/");
    expect(init.supervisionUrls).toBeUndefined();
  });

  it("does not build a pool for a one-element list", () => {
    const init = parseCreateBody({ ...OCPP_J, wsUrl: ["ws://a/ocpp/"] });
    expect(init.wsUrl).toBe("ws://a/ocpp/");
    expect(init.supervisionUrls).toBeUndefined();
  });

  it("carries the distribution policy through", () => {
    const init = parseCreateBody({
      ...OCPP_J,
      wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
      urlDistribution: "cp-affinity",
    });
    expect(init.urlDistribution).toBe("cp-affinity");
  });

  it("ignores an unrecognised distribution rather than guessing", () => {
    const init = parseCreateBody({
      ...OCPP_J,
      wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
      urlDistribution: "nearest",
    });
    expect(init.urlDistribution).toBeUndefined();
  });

  it("refuses a list for the SOAP versions", () => {
    // SOAP posts to the Central System service and is called back on one
    // advertised address; there is no reconnect loop to rotate, so a list
    // would be accepted and then silently ignored.
    expect(() =>
      parseCreateBody({
        ...OCPP_J,
        ocppVersion: "OCPP-1.6S",
        soapCallbackUrl: "http://sim/ocpp/soap/CP001/ChargePointService",
        wsUrl: [
          "http://a/CentralSystemService",
          "http://b/CentralSystemService",
        ],
      }),
    ).toThrow(/single URL for the OCPP SOAP versions/);
  });

  it("refuses an empty or non-string entry", () => {
    expect(() => parseCreateBody({ ...OCPP_J, wsUrl: [] })).toThrow();
    expect(() =>
      parseCreateBody({ ...OCPP_J, wsUrl: ["ws://a/ocpp/", ""] }),
    ).toThrow(/non-empty strings/);
    expect(() =>
      parseCreateBody({ ...OCPP_J, wsUrl: ["ws://a/ocpp/", 42] }),
    ).toThrow(/non-empty strings/);
  });

  it("is expressible through the cp.create schema", () => {
    expect(
      createParamsSchema.safeParse({
        cpId: "CP001",
        wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
        urlDistribution: "round-robin",
      }).success,
    ).toBe(true);
    expect(
      createParamsSchema.safeParse({ cpId: "CP001", wsUrl: [] }).success,
    ).toBe(false);
    expect(
      createParamsSchema.safeParse({
        cpId: "CP001",
        wsUrl: "ws://a/ocpp/",
        urlDistribution: "nearest",
      }).success,
    ).toBe(false);
  });
});

describe("supervision URLs survive the control-plane path (#296)", () => {
  it("reaches the charge point instead of being dropped by the facade", async () => {
    // The unit tests above only prove `parseCreateBody` produces the list.
    // They passed while `RegistryChargePointService.toInitOptions()` silently
    // dropped it, so the charge point came up on the first URL with no pool
    // and `cp.create` still answered success. This asserts the whole path.
    const registry = new CPRegistry(new EventBus());
    const service = new RegistryChargePointService(registry);
    try {
      const init = parseCreateBody({
        cpId: "CP-POOL",
        connectors: 1,
        wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/", "ws://c/ocpp/"],
        urlDistribution: "cp-affinity",
      });
      await service.createChargePoint(init);

      const stored = registry.get("CP-POOL")?.getInit();
      expect(stored?.supervisionUrls).toHaveLength(3);
      expect(stored?.urlDistribution).toBe("cp-affinity");
    } finally {
      registry.shutdownAll();
    }
  });

  it("keeps the list across an update that does not mention it", async () => {
    const registry = new CPRegistry(new EventBus());
    const service = new RegistryChargePointService(registry);
    try {
      await service.createChargePoint(
        parseCreateBody({
          cpId: "CP-KEEP",
          connectors: 1,
          wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
        }),
      );
      await service.updateChargePoint({
        cpId: "CP-KEEP",
        wsUrl: "ws://a/ocpp/",
        model: "Renamed",
      });

      expect(registry.get("CP-KEEP")?.getInit().supervisionUrls).toEqual([
        "ws://a/ocpp/",
        "ws://b/ocpp/",
      ]);
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("SupervisionUrlPool inspection is side-effect free (#296)", () => {
  it("does not consume the random draw", () => {
    // `setSupervisionUrlPool` calls `current()` at wiring time. When that
    // consumed the RNG, the first seeded selection was thrown away and any
    // later inspection changed which node the next attempt would use.
    const urls = ["ws://a/", "ws://b/", "ws://c/"];
    const inspected = new SupervisionUrlPool(urls, "random", "CP1");
    inspected.current();
    inspected.current();
    const fresh = new SupervisionUrlPool(urls, "random", "CP1");
    expect(inspected.next()).toBe(fresh.next());
  });
});
