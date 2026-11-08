import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";
import { createParamsSchema } from "@ocpp-cp-sim/contracts/index";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import { BunSqliteDatabase } from "@ocpp-cp-sim/core/cp/domain/persistence/BunSqliteDatabase";

// #609: `transport.reconnect` travels cp.create → facade → charge point →
// registry row → restore, and a typo is refused rather than ignored.

const BASE = { cpId: "CP-609", connectors: 1, wsUrl: "ws://a/ocpp/" };
const RECONNECT = {
  maxAttempts: 3,
  mode: "fixed",
  baseDelayMs: 500,
  maxDelayMs: 4000,
  jitterMs: 100,
  bootRetryLimit: 2,
} as const;

describe("transport.reconnect on the control plane (#609)", () => {
  it("is parsed by parseCreateBody", () => {
    const init = parseCreateBody({
      ...BASE,
      transport: { reconnect: RECONNECT },
    });
    expect(init.transport).toEqual({ reconnect: RECONNECT });
    expect(parseCreateBody(BASE).transport).toBeUndefined();
  });

  it("refuses unknown fields, bad values and an inverted range", () => {
    const bad = (reconnect: unknown) =>
      expect(() =>
        parseCreateBody({ ...BASE, transport: { reconnect } }),
      ).toThrow(/transport is invalid/);
    bad({ maxAttempt: 3 });
    bad({ maxAttempts: -2 });
    bad({ maxAttempts: 1.5 });
    bad({ mode: "linear" });
    bad({ jitterMs: -1 });
    bad({ baseDelayMs: 5000, maxDelayMs: 1000 });
    expect(() => parseCreateBody({ ...BASE, transport: { tcp: {} } })).toThrow(
      /transport is invalid/,
    );
  });

  it("is expressible through the cp.create schema", () => {
    expect(
      createParamsSchema.safeParse({
        ...BASE,
        transport: { reconnect: RECONNECT },
      }).success,
    ).toBe(true);
    expect(
      createParamsSchema.safeParse({
        ...BASE,
        transport: { reconnect: { mode: "linear" } },
      }).success,
    ).toBe(false);
  });

  it("reaches the charge point and keeps across an update that omits it", async () => {
    const registry = new CPRegistry(new EventBus());
    const service = createRuntimeDeps({
      registry,
      bus: new EventBus(),
    }).chargePointService;
    try {
      await service.createChargePoint(
        parseCreateBody({ ...BASE, transport: { reconnect: RECONNECT } }),
      );
      expect(registry.get("CP-609")?.getInit().transport).toEqual({
        reconnect: RECONNECT,
      });
      const cp = registry.get("CP-609")!["_chargePoint"];
      expect(cp["_webSocket"]!.reconnectPolicy).toMatchObject(RECONNECT);

      await service.updateChargePoint(
        parseCreateBody({ ...BASE, model: "M2" }),
      );
      expect(registry.get("CP-609")?.getInit().transport).toEqual({
        reconnect: RECONNECT,
      });
    } finally {
      registry.shutdownAll();
    }
  });

  it("persists and restores, and an old row restores to the defaults", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      const row = {
        wsUrl: "ws://a/ocpp/",
        connectors: 1,
        vendor: "V",
        model: "M",
        basicAuth: null,
      };
      first.create(
        { ...row, cpId: "CP-SET", transport: { reconnect: RECONNECT } },
        { seedDefault: false },
      );
      first.create({ ...row, cpId: "CP-PLAIN" }, { seedDefault: false });
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        second.restoreFromDatabase();
        expect(second.get("CP-SET")?.getInit().transport).toEqual({
          reconnect: RECONNECT,
        });
        expect(second.get("CP-PLAIN")?.getInit().transport).toBeUndefined();
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });

  it("stores the transport settings next to the inbound validation mode", () => {
    // Both columns share one INSERT: a missing `?` placeholder fails every
    // cp.create under --state-db.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        {
          cpId: "CP-BOTH",
          wsUrl: "ws://a/ocpp/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          inboundValidation: "enforce",
          transport: { reconnect: RECONNECT },
        },
        { seedDefault: false },
      );
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        second.restoreFromDatabase();
        const init = second.get("CP-BOTH")?.getInit();
        expect(init?.inboundValidation).toBe("enforce");
        expect(init?.transport).toEqual({ reconnect: RECONNECT });
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });

  it("drops a damaged stored value with the defaults instead of failing the restore", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        {
          cpId: "CP-BAD",
          wsUrl: "ws://a/ocpp/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
        },
        { seedDefault: false },
      );
      first.shutdownAll();
      db.run("UPDATE charge_points SET transport_options = ?", [
        '{"reconnect":{"mode":"linear"}}',
      ]);

      const second = new CPRegistry(new EventBus(), db);
      try {
        expect(second.restoreFromDatabase()).toContain("CP-BAD");
        expect(second.get("CP-BAD")?.getInit().transport).toBeUndefined();
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });
});
