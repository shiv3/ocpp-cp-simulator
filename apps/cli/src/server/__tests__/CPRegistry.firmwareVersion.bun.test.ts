// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";

import { CPRegistry } from "../CPRegistry";
import { CLIChargePointService } from "../../service";
import { EventBus } from "../eventBus";

function chargePointOf(registry: CPRegistry, cpId: string): ChargePoint {
  const svc = registry.get(cpId);
  if (!svc) throw new Error(`no charge point ${cpId}`);
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

/** A firmware update with `bumpVersion` installed a new version: the row's
 *  boot data follows, so a restart boots with it. */
describe("CPRegistry keeps the firmwareVersion a firmware update installed", () => {
  it("writes boot_notif, keeps the other boot fields, and a restart boots with it", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "cp-fw",
          wsUrl: "ws://127.0.0.1:9/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          bootNotification: {
            firmwareVersion: "1.0",
            chargePointSerialNumber: "SN-1",
          },
        },
        { seedDefault: false },
      );
      chargePointOf(registry, "cp-fw").setFirmwareVersion("2.3.1");

      expect(registry.get("cp-fw")?.getInit().bootNotification).toEqual({
        firmwareVersion: "2.3.1",
        chargePointSerialNumber: "SN-1",
      });
      const row = db.get<{ boot_notif: string | null }>(
        "SELECT boot_notif FROM charge_points WHERE cp_id = ?",
        ["cp-fw"],
      );
      expect(JSON.parse(row?.boot_notif ?? "null")).toEqual({
        firmwareVersion: "2.3.1",
        chargePointSerialNumber: "SN-1",
      });

      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase()).toEqual(["cp-fw"]);
      const boot = chargePointOf(restored, "cp-fw").bootPayload();
      expect(boot.firmwareVersion).toBe("2.3.1");
      expect(boot.chargePointSerialNumber).toBe("SN-1");
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });
});

/** The standalone service a `cp.update` falls back to: `registerExisting`
 *  wires no persistence listener, and the installed version must still
 *  reach `getInit()`. */
describe("CLIChargePointService keeps the installed firmwareVersion in its init", () => {
  it("follows the change with no listener, registered through registerExisting", () => {
    const registry = new CPRegistry(new EventBus());
    const svc = new CLIChargePointService({
      cpId: "cp-fw-standalone",
      wsUrl: "ws://127.0.0.1:9/",
      connectors: 1,
      vendor: "V",
      model: "M",
      basicAuth: null,
      bootNotification: {
        firmwareVersion: "1.0",
        chargePointSerialNumber: "SN-1",
      },
    });
    try {
      registry.registerExisting(svc);
      (
        svc as unknown as { _chargePoint: ChargePoint }
      )._chargePoint.setFirmwareVersion("2.3.1");
      expect(svc.getInit().bootNotification).toEqual({
        firmwareVersion: "2.3.1",
        chargePointSerialNumber: "SN-1",
      });
    } finally {
      registry.shutdownAll();
    }
  });
});
