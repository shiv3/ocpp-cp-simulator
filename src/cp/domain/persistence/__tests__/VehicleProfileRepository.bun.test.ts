// Runs under `bun test`: the daemon's `bun:sqlite` database.
import { describe, expect, it } from "bun:test";

import type { VehicleProfile } from "../../vehicle/VehicleProfile";
import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { resetSimulatorState } from "../resetState";
import { MAX_VEHICLE_PROFILES } from "../../../../protocol/vehicle";
import {
  VehicleProfileLimitError,
  VehicleProfileRepository,
} from "../VehicleProfileRepository";

function profile(id: string, name: string): VehicleProfile {
  return {
    id,
    name,
    specs: {
      usableBatteryKwh: null,
      acMaxKw: 11,
      acPhases: 3,
      dcMaxKw: 200,
      acConnectors: ["IEC_62196_T2"],
      dcConnectors: [],
    },
    dcCurve: [{ socPercent: 0, powerKw: 200 }],
    overrides: { usableBatteryKwh: 86 },
    origin: null,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
  };
}

for (const [label, open] of [
  ["bun:sqlite", () => BunSqliteDatabase.open(":memory:")],
  ["no database", () => null],
] as const) {
  describe(`VehicleProfileRepository — ${label} (#458)`, () => {
    it("saves, lists by name, reads and deletes", () => {
      const repo = new VehicleProfileRepository(open());
      repo.save(profile("b", "Zoe"));
      repo.save(profile("a", "ID.7"));
      expect(repo.list().map((p) => p.name)).toEqual(["ID.7", "Zoe"]);
      expect(repo.get("a")).toEqual(profile("a", "ID.7"));
      expect(repo.delete("a")).toBe(true);
      expect(repo.delete("a")).toBe(false);
      expect(repo.list().map((p) => p.id)).toEqual(["b"]);
    });

    it("replaces a profile saved again under the same id", () => {
      const repo = new VehicleProfileRepository(open());
      repo.save(profile("a", "ID.7"));
      repo.save({ ...profile("a", "My ID.7"), overrides: {} });
      expect(repo.list()).toHaveLength(1);
      expect(repo.get("a")?.name).toBe("My ID.7");
      expect(repo.get("a")?.overrides).toEqual({});
    });

    it("refuses a profile that does not match the schema", () => {
      const repo = new VehicleProfileRepository(open());
      expect(() => repo.save({ ...profile("a", "x"), name: "" })).toThrow();
      expect(repo.list()).toEqual([]);
    });

    it("refuses a new profile beyond the limit, but still replaces one", () => {
      const repo = new VehicleProfileRepository(open());
      for (let i = 0; i < MAX_VEHICLE_PROFILES; i++) {
        repo.save(profile(`p${i}`, `P${i}`));
      }
      expect(() => repo.save(profile("one-more", "X"))).toThrow(
        VehicleProfileLimitError,
      );
      expect(() => repo.save(profile("p0", "Renamed"))).not.toThrow();
      expect(repo.count()).toBe(MAX_VEHICLE_PROFILES);
    });

    it("clears every profile", () => {
      const repo = new VehicleProfileRepository(open());
      repo.save(profile("a", "A"));
      repo.save(profile("b", "B"));
      repo.clear();
      expect(repo.list()).toEqual([]);
      expect(repo.count()).toBe(0);
    });

    it("does not store fields the schema does not name", () => {
      const repo = new VehicleProfileRepository(open());
      repo.save({ ...profile("a", "x"), apiKey: "secret" } as VehicleProfile);
      expect(JSON.stringify(repo.get("a"))).not.toContain("secret");
    });
  });
}

describe("VehicleProfileRepository — stored rows (#458)", () => {
  it("skips a row that no longer parses instead of failing the list", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const repo = new VehicleProfileRepository(db);
    repo.save(profile("a", "ID.7"));
    db.run(
      "INSERT INTO vehicle_profiles (id, name, body, updated_at) VALUES ('bad', 'Bad', '{\"id\":1}', 'x')",
    );
    expect(repo.list().map((p) => p.id)).toEqual(["a"]);
    expect(repo.get("bad")).toBeNull();
  });

  it("is emptied by state.reset", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const repo = new VehicleProfileRepository(db);
    repo.save(profile("a", "ID.7"));
    resetSimulatorState(db);
    expect(repo.list()).toEqual([]);
  });
});
