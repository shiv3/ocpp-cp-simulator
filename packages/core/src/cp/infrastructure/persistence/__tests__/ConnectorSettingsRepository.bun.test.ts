// Runs under `bun test`: the SQLite implementation uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../BunSqliteDatabase";
import { SqliteConnectorSettingsRepository } from "../SqliteConnectorSettingsRepository";
import { NoopConnectorSettingsRepository } from "../../../domain/persistence/ConnectorSettingsRepository";
import { createChargePointRepositories } from "../createChargePointRepositories";

/** §5.2: the `connector_settings` availability flag survives a reboot (#878). */

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  opened.push(db);
  return db;
}

describe("SqliteConnectorSettingsRepository", () => {
  it("round-trips the availability per connector, overwriting the last one", () => {
    const db = openDb();
    const repo = new SqliteConnectorSettingsRepository("CP-A", db);
    expect(repo.loadAvailability(0)).toBeNull();

    repo.saveAvailability(0, "Inoperative");
    repo.saveAvailability(1, "Operative");
    repo.saveAvailability(1, "Inoperative");

    const restarted = new SqliteConnectorSettingsRepository("CP-A", db);
    expect(restarted.loadAvailability(0)).toBe("Inoperative");
    expect(restarted.loadAvailability(1)).toBe("Inoperative");
    expect(restarted.loadAvailability(2)).toBeNull();
    expect(
      new SqliteConnectorSettingsRepository("CP-B", db).loadAvailability(0),
    ).toBeNull();
  });

  it("ignores a stored value that is not an availability", () => {
    const db = openDb();
    db.run(
      "INSERT INTO connector_settings (cp_id, connector_id, availability) VALUES ('CP-A', 1, 'Broken')",
    );
    expect(
      new SqliteConnectorSettingsRepository("CP-A", db).loadAvailability(1),
    ).toBeNull();
  });

  it("does nothing without a database", () => {
    const repo = new NoopConnectorSettingsRepository();
    repo.saveAvailability(0, "Inoperative");
    expect(repo.loadAvailability(0)).toBeNull();
  });
});

describe("createChargePointRepositories", () => {
  it("binds the SQLite repositories to the charge point", () => {
    const db = openDb();
    createChargePointRepositories(
      "CP-A",
      db,
    ).connectorSettings.saveAvailability(0, "Inoperative");
    expect(
      createChargePointRepositories(
        "CP-A",
        db,
      ).connectorSettings.loadAvailability(0),
    ).toBe("Inoperative");
    expect(
      createChargePointRepositories(
        "CP-B",
        db,
      ).connectorSettings.loadAvailability(0),
    ).toBeNull();
  });

  it("falls back to no-op repositories without a database", () => {
    expect(
      createChargePointRepositories("CP-A", null).connectorSettings,
    ).toBeInstanceOf(NoopConnectorSettingsRepository);
  });
});
