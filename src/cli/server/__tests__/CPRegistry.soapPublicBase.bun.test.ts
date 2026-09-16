// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { describe, it, expect, spyOn } from "bun:test";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../cp/domain/persistence/Database";

const CSMS = "http://127.0.0.1:1/steve/services/CentralSystemService";

function soapInit(cpId: string, soapCallbackUrl?: string) {
  return {
    cpId,
    wsUrl: CSMS,
    connectors: 1,
    vendor: "TestVendor",
    model: "TestModel",
    basicAuth: null,
    ocppVersion: "OCPP-1.6S",
    ...(soapCallbackUrl ? { soapCallbackUrl } : {}),
  };
}

function createRegistry(
  database: Database | null,
  soapPublicBaseUrl: string | null,
): CPRegistry {
  return new CPRegistry(new EventBus(), database, {
    soapPublicBaseUrl,
    soapPath: "/ocpp/soap",
  });
}

describe("CPRegistry SOAP public base (#183)", () => {
  it("derives the callback URL of a SOAP charge point created without one", () => {
    const registry = createRegistry(null, "https://a1b2.ngrok-free.app");
    try {
      const svc = registry.create(soapInit("CP-1"), { seedDefault: false });
      const config = svc.getStatus().config;
      expect(config?.soapCallbackUrl).toBe(
        "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
      );
      expect(config?.soapCallbackUrlDerived).toBe(true);
    } finally {
      registry.shutdownAll();
    }
  });

  it("keeps an explicit callback URL and does not mark it derived", () => {
    const registry = createRegistry(null, "https://a1b2.ngrok-free.app");
    try {
      const svc = registry.create(
        soapInit(
          "CP-1",
          "https://explicit.test/ocpp/soap/CP-1/ChargePointService",
        ),
        { seedDefault: false },
      );
      const config = svc.getStatus().config;
      expect(config?.soapCallbackUrl).toBe(
        "https://explicit.test/ocpp/soap/CP-1/ChargePointService",
      );
      expect(config?.soapCallbackUrlDerived).toBeFalsy();
    } finally {
      registry.shutdownAll();
    }
  });

  it("still refuses a SOAP charge point without a callback URL when there is no base", () => {
    const registry = createRegistry(null, null);
    try {
      expect(() =>
        registry.create(soapInit("CP-1"), { seedDefault: false }),
      ).toThrow(/callback URL/);
    } finally {
      registry.shutdownAll();
    }
  });

  it("does not persist a derived URL, and re-derives from the current base on restore", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = createRegistry(db, "https://run-one.ngrok-free.app");
    let restored: CPRegistry | null = null;
    try {
      registry.create(soapInit("CP-1"), { seedDefault: false });
      const row = db.get<{ soap_callback_url: string | null }>(
        "SELECT soap_callback_url FROM charge_points WHERE cp_id = ?",
        ["CP-1"],
      );
      // A free-tier tunnel URL changes between runs; a persisted copy would
      // come back stale on the next daemon start.
      expect(row?.soap_callback_url).toBeNull();

      registry.shutdownAll();
      restored = createRegistry(db, "https://run-two.ngrok-free.app");
      expect(restored.restoreFromDatabase()).toEqual(["CP-1"]);
      const config = restored.get("CP-1")?.getStatus().config;
      expect(config?.soapCallbackUrl).toBe(
        "https://run-two.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
      );
      expect(config?.soapCallbackUrlDerived).toBe(true);
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });

  it("skips a SOAP charge point it cannot derive a callback for when the base is gone, and restores the rest (#354 follow-up)", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = createRegistry(db, "https://run-one.ngrok-free.app");
    let restored: CPRegistry | null = null;
    let again: CPRegistry | null = null;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      registry.create(soapInit("CP-soap"), { seedDefault: false });
      registry.create(
        {
          ...soapInit("CP-ws"),
          ocppVersion: "OCPP-1.6J",
          wsUrl: "ws://127.0.0.1:1/ocpp",
        },
        { seedDefault: false },
      );
      registry.shutdownAll();

      // The next run has no tunnel and no --soap-public-base-url. Before the
      // fix the SOAP row threw out of the service constructor and the whole
      // restore — the healthy WebSocket row included — never happened.
      restored = createRegistry(db, null);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP-ws",
      ]);
      expect(restored.get("CP-soap")).toBeUndefined();
      expect(restored.get("CP-ws")).toBeDefined();
      const line = warn.mock.calls
        .map((call) => call.map(String).join(" "))
        .find((text) => text.includes('"CP-soap"'));
      expect(line).toContain("--soap-tunnel");
      expect(line).toContain("--soap-public-base-url");

      // The row was skipped, not deleted: a run with a base brings it back.
      expect(
        db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM charge_points WHERE cp_id = ?",
          ["CP-soap"],
        )?.n,
      ).toBe(1);
      restored.shutdownAll();
      again = createRegistry(db, "https://run-two.ngrok-free.app");
      expect(again.restoreFromDatabase({ connect: false }).sort()).toEqual([
        "CP-soap",
        "CP-ws",
      ]);
      expect(again.get("CP-soap")?.getStatus().config?.soapCallbackUrl).toBe(
        "https://run-two.ngrok-free.app/ocpp/soap/CP-soap/ChargePointService",
      );
    } finally {
      warn.mockRestore();
      registry.shutdownAll();
      restored?.shutdownAll();
      again?.shutdownAll();
      db.close();
    }
  });

  it("an update without a callback URL re-derives instead of keeping the stale one", () => {
    const registry = createRegistry(null, "https://a1b2.ngrok-free.app");
    try {
      registry.create(soapInit("CP-1"), { seedDefault: false });
      const updated = registry.update({ ...soapInit("CP-1"), vendor: "Other" });
      const config = updated.getStatus().config;
      expect(config?.vendor).toBe("Other");
      expect(config?.soapCallbackUrl).toBe(
        "https://a1b2.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
      );
      expect(config?.soapCallbackUrlDerived).toBe(true);
    } finally {
      registry.shutdownAll();
    }
  });

  it("leaves a WebSocket charge point alone even when a base is configured", () => {
    const registry = createRegistry(null, "https://a1b2.ngrok-free.app");
    try {
      const svc = registry.create(
        {
          ...soapInit("CP-1"),
          ocppVersion: "OCPP-1.6J",
          wsUrl: "ws://127.0.0.1:1/ocpp",
        },
        { seedDefault: false },
      );
      const config = svc.getStatus().config;
      expect(config?.soapCallbackUrl).toBeUndefined();
      expect(config?.soapCallbackUrlDerived).toBeFalsy();
    } finally {
      registry.shutdownAll();
    }
  });

  it("honours the charge point's own soapPath over the daemon default", () => {
    const registry = createRegistry(null, "https://a1b2.ngrok-free.app");
    try {
      const svc = registry.create(
        { ...soapInit("CP-1"), soapPath: "/custom" },
        { seedDefault: false },
      );
      expect(svc.getStatus().config?.soapCallbackUrl).toBe(
        "https://a1b2.ngrok-free.app/custom/CP-1/ChargePointService",
      );
    } finally {
      registry.shutdownAll();
    }
  });
});
