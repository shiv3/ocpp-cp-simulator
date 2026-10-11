import { describe, expect, it, vi } from "vitest";

import type { VehicleProfile } from "../../cp/domain/vehicle/VehicleProfile";
import { memoryDatabase } from "../../test/sqlJsMemoryDatabase";
import { LocalChargePointService } from "./LocalChargePointService";

/** The browser's sql.js database, with a `flush` spy for its writes. */
async function flushingDatabase() {
  return Object.assign(await memoryDatabase(), {
    flush: vi.fn(async () => {}),
  });
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
    const database = await flushingDatabase();
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
    const service = new LocalChargePointService(await flushingDatabase());
    await expect(service.deleteVehicleProfile("nope")).rejects.toThrow(
      /not found/,
    );
  });

  it("rejects an invalid profile instead of storing it", async () => {
    const service = new LocalChargePointService(await flushingDatabase());
    await expect(
      service.saveVehicleProfile({ ...PROFILE, name: "" }),
    ).rejects.toThrow();
    await expect(service.listVehicleProfiles()).resolves.toEqual([]);
  });

  it("loses the profiles to Reset all simulator data", async () => {
    const service = new LocalChargePointService(await flushingDatabase());
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
