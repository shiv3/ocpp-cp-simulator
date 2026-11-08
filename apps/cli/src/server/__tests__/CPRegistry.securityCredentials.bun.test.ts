// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";

const OLD_KEY = "11".repeat(16);
const NEW_KEY = "22".repeat(16);

function chargePointOf(registry: CPRegistry, cpId: string): ChargePoint {
  const svc = registry.get(cpId);
  if (!svc) throw new Error(`no charge point ${cpId}`);
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

/** #724: the Goal "after Accepted, the next connection (… restart with
 *  persistence) uses the stored value". */
describe("CPRegistry keeps credentials changed by ChangeConfiguration (#724)", () => {
  it("a restart rebuilds the station with the changed AuthorizationKey and SecurityProfile", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "cp-cred",
          wsUrl: "ws://127.0.0.1:9/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          securityProfile: 1,
          authorizationKey: OLD_KEY,
        },
        { seedDefault: false },
      );
      const configuration = chargePointOf(registry, "cp-cred").configuration;
      expect(configuration.applyChange("AuthorizationKey", NEW_KEY)).toBe(
        "Accepted",
      );
      // The A05 guard is installed: an empty key is refused, the row keeps NEW_KEY.
      expect(configuration.applyChange("AuthorizationKey", "")).toBe(
        "Rejected",
      );
      expect(registry.get("cp-cred")?.getInit().authorizationKey).toBe(NEW_KEY);
      // A profile change the CP made on its own (the A05.FR.08 fallback path).
      configuration.applyChange("SecurityProfile", "0", { bypassGuard: true });

      const row = db.get<{
        authorization_key: string | null;
        security_profile: number | null;
      }>(
        "SELECT authorization_key, security_profile FROM charge_points WHERE cp_id = ?",
        ["cp-cred"],
      );
      expect(row).toEqual({
        authorization_key: NEW_KEY,
        security_profile: 0,
      });

      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase()).toEqual(["cp-cred"]);
      const after = chargePointOf(restored, "cp-cred").configuration;
      expect(after.getString("AuthorizationKey")).toBe(NEW_KEY);
      expect(after.getInteger("SecurityProfile")).toBe(0);
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });
});
