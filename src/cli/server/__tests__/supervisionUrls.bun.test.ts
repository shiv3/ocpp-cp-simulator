import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";
import { createParamsSchema } from "../../../protocol";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { RegistryChargePointService } from "../RegistryChargePointService";
import {
  DEFAULT_AFFINITY_FAILOVER_THRESHOLD,
  SupervisionUrlPool,
} from "../../../cp/infrastructure/transport/SupervisionUrlPool";
import { OCPPWebSocket } from "../../../cp/infrastructure/transport/OCPPWebSocket";
import { Logger } from "../../../cp/shared/Logger";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { toWireCreateParams } from "../../../data/remote/RemoteChargePointService";

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

  it("refuses an unrecognised distribution rather than defaulting", () => {
    // A typo would otherwise succeed and hand back round-robin when the caller
    // asked for affinity — the opposite of the determinism affinity is for.
    expect(() =>
      parseCreateBody({
        ...OCPP_J,
        wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
        urlDistribution: "round_robin",
      }),
    ).toThrow(/urlDistribution must be/);
    expect(
      parseCreateBody({ ...OCPP_J, wsUrl: "ws://a/ocpp/" }).urlDistribution,
    ).toBeUndefined();
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

  it("refuses a malformed later entry, not just the first", () => {
    // A later member is only reached at reconnect, where buildOcppWebSocketUrl
    // calls new URL() synchronously inside a setTimeout callback: a malformed
    // one throws there, uncaught, and takes the daemon down rather than
    // failing over to the next node.
    expect(() =>
      parseCreateBody({
        ...OCPP_J,
        wsUrl: ["ws://a/ocpp/", "not a url"],
      }),
    ).toThrow(/not a ws:\/\/ or wss:\/\/ URL/);
    expect(() =>
      parseCreateBody({
        ...OCPP_J,
        wsUrl: ["ws://a/ocpp/", "http://b/ocpp/"],
      }),
    ).toThrow(/not a ws:\/\/ or wss:\/\/ URL/);
    expect(
      parseCreateBody({
        ...OCPP_J,
        wsUrl: ["ws://a/ocpp/", "wss://b/ocpp/"],
      }).supervisionUrls,
    ).toHaveLength(2);
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

  it("clears the pool when an update names a single endpoint", async () => {
    // `wsUrl` is required on update, so an update fully specifies the URL
    // configuration. Falling back to the stored list would leave a charge
    // point that was just pointed at one endpoint still failing over to the
    // stale pool — and still persisting it.
    const registry = new CPRegistry(new EventBus());
    const service = new RegistryChargePointService(registry);
    try {
      await service.createChargePoint(
        parseCreateBody({
          cpId: "CP-CLEAR",
          connectors: 1,
          wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
        }),
      );
      expect(registry.get("CP-CLEAR")?.getInit().supervisionUrls).toHaveLength(
        2,
      );

      await service.updateChargePoint(
        parseCreateBody({
          cpId: "CP-CLEAR",
          connectors: 1,
          wsUrl: "ws://a/ocpp/",
        }),
      );
      expect(
        registry.get("CP-CLEAR")?.getInit().supervisionUrls,
      ).toBeUndefined();
    } finally {
      registry.shutdownAll();
    }
  });

  it("keeps the list across an update that repeats it", async () => {
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
      await service.updateChargePoint(
        parseCreateBody({
          cpId: "CP-KEEP",
          connectors: 1,
          wsUrl: ["ws://a/ocpp/", "ws://b/ocpp/"],
          model: "Renamed",
        }),
      );

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

describe("supervision URLs survive a daemon restart (#296)", () => {
  it("persists the list and the policy, and restores them", () => {
    // The list is the failover configuration. Restoring a charge point with
    // only `ws_url` brings it back with failover silently disabled — the one
    // thing a URL list exists to provide — and nothing would say so.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        {
          cpId: "CP-RESTART",
          wsUrl: "ws://a/ocpp/",
          supervisionUrls: ["ws://a/ocpp/", "ws://b/ocpp/", "ws://c/ocpp/"],
          urlDistribution: "cp-affinity",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
        },
        { seedDefault: false },
      );
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        expect(second.restoreFromDatabase()).toContain("CP-RESTART");
        const init = second.get("CP-RESTART")?.getInit();
        expect(init?.wsUrl).toBe("ws://a/ocpp/");
        expect(init?.supervisionUrls).toEqual([
          "ws://a/ocpp/",
          "ws://b/ocpp/",
          "ws://c/ocpp/",
        ]);
        expect(init?.urlDistribution).toBe("cp-affinity");
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });

  it("leaves a single-URL charge point exactly as it was", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        {
          cpId: "CP-SINGLE",
          wsUrl: "ws://a/ocpp/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
        },
        { seedDefault: false },
      );
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        second.restoreFromDatabase();
        const init = second.get("CP-SINGLE")?.getInit();
        expect(init?.wsUrl).toBe("ws://a/ocpp/");
        expect(init?.supervisionUrls).toBeUndefined();
        expect(init?.urlDistribution).toBeUndefined();
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });
});

describe("the typed remote adapter does not lose the list (#296)", () => {
  it("folds supervisionUrls into the wire wsUrl array", () => {
    // `CreateChargePointParams` keeps the list in a field of its own because
    // that is what the charge point consumes, but the wire expresses it as an
    // array `wsUrl`. Forwarding the typed shape verbatim let the schema strip
    // the unknown key: the call succeeded and quietly made a single-URL CP.
    const wire = toWireCreateParams({
      cpId: "CP-REMOTE",
      wsUrl: "ws://a/ocpp/",
      supervisionUrls: ["ws://a/ocpp/", "ws://b/ocpp/"],
      urlDistribution: "round-robin",
    });

    expect(wire.wsUrl).toEqual(["ws://a/ocpp/", "ws://b/ocpp/"]);
    expect("supervisionUrls" in wire).toBe(false);
    // And it survives the schema the daemon validates against.
    const parsed = createParamsSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    expect(parseCreateBody(wire).supervisionUrls).toHaveLength(2);
  });

  it("leaves a single-URL charge point alone", () => {
    const wire = toWireCreateParams({
      cpId: "CP-REMOTE",
      wsUrl: "ws://a/ocpp/",
    });
    expect(wire.wsUrl).toBe("ws://a/ocpp/");
  });

  it("does not promote a one-element list to an array", () => {
    const wire = toWireCreateParams({
      cpId: "CP-REMOTE",
      wsUrl: "ws://a/ocpp/",
      supervisionUrls: ["ws://a/ocpp/"],
    });
    expect(wire.wsUrl).toBe("ws://a/ocpp/");
  });
});

describe("only genuine transport failures move the pool (#296)", () => {
  it("does not count a reset or an injected disconnect", () => {
    // `disconnectInternal()` (behind ChargePoint.reset()) and
    // `simulateConnectionLoss()` both leave `_isManualDisconnect` false so the
    // reconnect loop still runs. Counting those as URL failures would scatter
    // an affinity fleet off its assigned nodes because of something the fleet
    // did to itself.
    const logger = new Logger();
    const ws = new OCPPWebSocket("ws://a/ocpp/", "CP1", logger);
    const pool = new SupervisionUrlPool(
      ["ws://a/ocpp/", "ws://b/ocpp/", "ws://c/ocpp/"],
      "cp-affinity",
      "CP1",
    );
    ws.setSupervisionUrlPool(pool);
    const primary = pool.current();

    for (let i = 0; i < DEFAULT_AFFINITY_FAILOVER_THRESHOLD + 2; i++) {
      ws.disconnectInternal();
    }
    expect(pool.next()).toBe(primary);

    for (let i = 0; i < DEFAULT_AFFINITY_FAILOVER_THRESHOLD + 2; i++) {
      ws.simulateConnectionLoss(0);
    }
    expect(pool.current()).toBe(primary);
  });
});
