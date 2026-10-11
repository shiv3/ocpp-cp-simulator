import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";

import type { Database, SqlParam } from "../../cp/domain/persistence/Database";
import { runMigrations } from "../../cp/domain/persistence/schema";
import type { VehicleProfile } from "../../cp/domain/vehicle/VehicleProfile";
import { LocalChargePointService } from "./LocalChargePointService";

/** sql.js behind the `Database` port, as the browser runs it. */
async function memoryDatabase(): Promise<
  Database & { flush: () => Promise<void> }
> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const coerce = (params: SqlParam[]) =>
    params.map((p) => (typeof p === "boolean" ? Number(p) : p));
  const adapter = {
    exec: (sql: string) => {
      db.exec(sql);
    },
    run: (sql: string, params: SqlParam[] = []) => {
      db.run(sql, coerce(params));
    },
    all: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      const rows: T[] = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
      } finally {
        stmt.free();
      }
      return rows;
    },
    get: <T>(sql: string, params: SqlParam[] = []) => {
      const stmt = db.prepare(sql, coerce(params));
      try {
        return stmt.step() ? (stmt.getAsObject() as T) : null;
      } finally {
        stmt.free();
      }
    },
    close: () => db.close(),
    flush: vi.fn(async () => {}),
  };
  runMigrations(adapter);
  return adapter;
}

const PROFILE: VehicleProfile = {
  id: "vp_1",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 3,
    dcMaxKw: 200,
    acConnectors: ["IEC_62196_T2"],
    dcConnectors: ["IEC_62196_T2_COMBO"],
  },
  dcCurve: [{ socPercent: 0, powerKw: 200 }],
  overrides: {},
  origin: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

describe("LocalChargePointService vehicle profiles (#458)", () => {
  it("stores profiles in the browser database and flushes each write", async () => {
    const database = await memoryDatabase();
    const service = new LocalChargePointService(database);

    await expect(service.saveVehicleProfile(PROFILE)).resolves.toEqual(PROFILE);
    expect(database.flush).toHaveBeenCalledTimes(1);
    // A fresh service over the same database sees it: it is persisted, not
    // cached.
    const reopened = new LocalChargePointService(database);
    await expect(reopened.listVehicleProfiles()).resolves.toEqual([PROFILE]);

    await reopened.deleteVehicleProfile("vp_1");
    expect(database.flush).toHaveBeenCalledTimes(2);
    await expect(service.listVehicleProfiles()).resolves.toEqual([]);
  });

  it("fails to delete a profile that is not there", async () => {
    const service = new LocalChargePointService(await memoryDatabase());
    await expect(service.deleteVehicleProfile("nope")).rejects.toThrow(
      /not found/,
    );
  });

  it("rejects an invalid profile instead of storing it", async () => {
    const service = new LocalChargePointService(await memoryDatabase());
    await expect(
      service.saveVehicleProfile({ ...PROFILE, name: "" }),
    ).rejects.toThrow();
    await expect(service.listVehicleProfiles()).resolves.toEqual([]);
  });

  it("loses the profiles to Reset all simulator data", async () => {
    const service = new LocalChargePointService(await memoryDatabase());
    await service.saveVehicleProfile(PROFILE);
    await service.resetAllState();
    await expect(service.listVehicleProfiles()).resolves.toEqual([]);
  });

  it("has no catalog of its own: Local mode calls the catalog from the console", () => {
    const service = new LocalChargePointService(null);
    expect(
      (service as { getVehicleCatalog?: unknown }).getVehicleCatalog,
    ).toBeUndefined();
  });
});
