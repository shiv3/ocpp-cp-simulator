// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { SqliteConfigurationOverrideRepository } from "../SqliteConfigurationOverrideRepository";
import { NoopConfigurationOverrideRepository } from "../../../domain/persistence/ConfigurationOverrideRepository";
import { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import { defaultConfiguration } from "../../../domain/charge-point/Configuration";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

/** The `configuration` table behind ChangeConfiguration overrides (#878). */

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  opened.push(db);
  return db;
}

describe("SqliteConfigurationOverrideRepository", () => {
  it("round-trips overrides per charge point, a save replacing the value", () => {
    const db = openDb();
    const repo = new SqliteConfigurationOverrideRepository("CP-A", db);
    expect(repo.loadAll()).toEqual([]);
    expect(repo.get("HeartbeatInterval")).toBeNull();

    repo.save("HeartbeatInterval", "60");
    repo.save("CpoName", '"Acme"');
    repo.save("HeartbeatInterval", "120");
    new SqliteConfigurationOverrideRepository("CP-B", db).save(
      "HeartbeatInterval",
      "30",
    );

    const restarted = new SqliteConfigurationOverrideRepository("CP-A", db);
    expect(
      restarted.loadAll().sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([
      { key: "CpoName", value: '"Acme"' },
      { key: "HeartbeatInterval", value: "120" },
    ]);
    expect(restarted.get("HeartbeatInterval")).toBe("120");
    expect(restarted.get("Unknown")).toBeNull();
  });

  it("does nothing without a database", () => {
    const repo = new NoopConfigurationOverrideRepository();
    repo.save("HeartbeatInterval", "60");
    expect(repo.loadAll()).toEqual([]);
    expect(repo.get("HeartbeatInterval")).toBeNull();
  });
});

describe("ConfigurationStore on SQLite", () => {
  const cpShape = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion: "OCPP-1.6J",
  } as ChargePoint;

  function storeOn(db: BunSqliteDatabase): ConfigurationStore {
    return new ConfigurationStore(
      defaultConfiguration(cpShape),
      new SqliteConfigurationOverrideRepository("CP-A", db),
    );
  }

  it("reads back a ChangeConfiguration and a vendor key after a restart", () => {
    const db = openDb();
    const first = storeOn(db);
    expect(first.applyChange("HeartbeatInterval", "42")).toBe("Accepted");
    first.defineWritableIntegerKey("VendorLimit", 16);
    expect(first.applyChange("VendorLimit", "10")).toBe("Accepted");

    const second = storeOn(db);
    expect(second.getInteger("HeartbeatInterval")).toBe(42);
    expect(second.defineWritableIntegerKey("VendorLimit", 16)).toBe(true);
    expect(second.getInteger("VendorLimit")).toBe(10);
  });
});
