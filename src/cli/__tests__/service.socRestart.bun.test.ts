import { describe, it, expect } from "bun:test";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "../../cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "../../cp/domain/persistence/schema";
import type { ChargePointInitOptions } from "../types";
import type { Connector } from "../../cp/domain/connector/Connector";
import type { Transaction } from "../../cp/domain/connector/Transaction";

/**
 * Whether a stored SoC is waiting for the next transaction has to cross the
 * disk with it (#301).
 *
 * `stopTransaction` leaves `socPercent` in place, so a session that has ended
 * leaves a value that is session-owned and transaction-less. Any rule that
 * tried to reconstruct ownership on restore from the rest of the snapshot
 * could not tell that from a value a user set while the connector was idle,
 * and the next transaction inherited the previous car's charge.
 *
 * These run a genuine restart: a second service over the same database,
 * rehydrating through `restoreConnectorRuntimeFromDatabase`.
 */
const INIT: ChargePointInitOptions = {
  cpId: "soc-cp",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
};

interface PersistablePrivates {
  _chargePoint: { connectors: Map<number, Connector> };
  persistConnectorRuntime(connector: Connector, connectorId: number): void;
}

function connectorOf(svc: CLIChargePointService): Connector {
  return (svc as unknown as PersistablePrivates)._chargePoint.connectors.get(
    1,
  )!;
}

/** The daemon persists on connector events; drive it explicitly so the test
 *  does not depend on which event happens to fire. */
function persist(svc: CLIChargePointService): void {
  const privates = svc as unknown as PersistablePrivates;
  privates.persistConnectorRuntime(connectorOf(svc), 1);
}

function transaction(initialSoc?: number): Transaction {
  return {
    id: 1,
    connectorId: 1,
    tagId: "TAG-SOC",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-07-01T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
    ...(initialSoc !== undefined ? { initialSoc } : {}),
  };
}

function freshDb(): BunSqliteDatabase {
  // `open` applies the schema; `runMigrations` is then the no-op re-stamp that
  // a real daemon boot performs.
  const db = BunSqliteDatabase.open(":memory:");
  runMigrations(db);
  return db;
}

describe("SoC ownership across a daemon restart (#301)", () => {
  it("does not let a finished session's SoC open the next transaction", () => {
    const db = freshDb();

    // Boot 1: a transaction carrying an explicit initialSoc, which the
    // ChargePoint writes through the `soc` setter before beginning. No meter
    // tick follows, so nothing else touches the value. Then it ends.
    const boot1 = new CLIChargePointService({ ...INIT }, db);
    boot1.setConnectorSocMeterSync(1, false);
    boot1.setConnectorSoc(1, 95);
    connectorOf(boot1).beginTransaction(transaction(95));
    connectorOf(boot1).stopTransaction();
    expect(connectorOf(boot1).soc).toBe(95);
    persist(boot1);

    // Boot 2: same database, fresh service.
    const boot2 = new CLIChargePointService({ ...INIT }, db);
    expect(boot2.restoreConnectorRuntimeFromDatabase()).toBeGreaterThan(0);
    expect(connectorOf(boot2).soc).toBe(95);

    // A different car, no initialSoc of its own. It must open on the EV
    // settings' value, not on what the previous session left behind.
    connectorOf(boot2).beginTransaction(transaction());
    expect(connectorOf(boot2).soc).toBe(boot2.getEVSettings(1).initialSoc);
  });

  it("keeps an SoC set while idle across the restart", () => {
    // The case that must keep working: type a value, the daemon restarts
    // before any transaction, then a session starts.
    const db = freshDb();

    const boot1 = new CLIChargePointService({ ...INIT }, db);
    boot1.setConnectorSocMeterSync(1, false);
    boot1.setConnectorSoc(1, 62);
    persist(boot1);

    const boot2 = new CLIChargePointService({ ...INIT }, db);
    boot2.restoreConnectorRuntimeFromDatabase();
    connectorOf(boot2).beginTransaction(transaction());
    expect(connectorOf(boot2).soc).toBe(62);
  });

  it("does not let an SoC set mid-session survive the restart", () => {
    const db = freshDb();

    const boot1 = new CLIChargePointService({ ...INIT }, db);
    boot1.setConnectorSocMeterSync(1, false);
    connectorOf(boot1).beginTransaction(transaction());
    boot1.setConnectorSoc(1, 88);
    connectorOf(boot1).stopTransaction();
    persist(boot1);

    const boot2 = new CLIChargePointService({ ...INIT }, db);
    boot2.restoreConnectorRuntimeFromDatabase();
    connectorOf(boot2).beginTransaction(transaction());
    expect(connectorOf(boot2).soc).toBe(boot2.getEVSettings(1).initialSoc);
  });

  it("keeps a restored in-flight transaction's SoC for that transaction", () => {
    // Restarting mid-session must not disturb the session that is resuming.
    const db = freshDb();

    const boot1 = new CLIChargePointService({ ...INIT }, db);
    boot1.setConnectorSocMeterSync(1, false);
    boot1.setConnectorSoc(1, 71);
    connectorOf(boot1).beginTransaction(transaction(71));
    persist(boot1);

    const boot2 = new CLIChargePointService({ ...INIT }, db);
    boot2.restoreConnectorRuntimeFromDatabase();
    expect(connectorOf(boot2).soc).toBe(71);
    expect(connectorOf(boot2).transaction).not.toBeNull();

    // …and once that session ends, it is a leftover like any other.
    connectorOf(boot2).stopTransaction();
    connectorOf(boot2).beginTransaction(transaction());
    expect(connectorOf(boot2).soc).toBe(boot2.getEVSettings(1).initialSoc);
  });
});
