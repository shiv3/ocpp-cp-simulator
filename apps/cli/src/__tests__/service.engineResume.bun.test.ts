import { describe, it, expect } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase } from "@ocpp-cp-sim/core/cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-sim/core/cp/domain/persistence/schema";
import type { Connector } from "@ocpp-cp-sim/core/cp/domain/connector/Connector";
import type { ChargePointInitOptions } from "../types";

// Persistence stores engine state (docs/analyses/charger-engine.md): the
// connector_runtime row is the connector's record in the charger engine's
// state, and after a restore the loaded behaviors get `onResume`.
const INIT: ChargePointInitOptions = {
  cpId: "resume-cp",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
};

interface Privates {
  _chargePoint: {
    connectors: Map<number, Connector>;
    engine: {
      state: {
        connectors: Record<string, { status: string; transaction: unknown }>;
      };
    };
    loadBehavior(behavior: Behavior): void;
  };
  persistConnectorRuntime(connector: Connector, connectorId: number): void;
}

const priv = (svc: CLIChargePointService) => svc as unknown as Privates;

function freshDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  runMigrations(db);
  return db;
}

describe("engine state across a restart", () => {
  it("restores the transaction into engine state and runs onResume once", () => {
    const db = freshDb();
    // A row as earlier builds wrote it: transaction_json holds ISO instants
    // and none of the 2.x bookkeeping fields.
    db.run(
      "INSERT INTO connector_runtime (cp_id, connector_id, status, availability, " +
        "scheduled_availability, transaction_json, meter_value_wh, soc_percent, " +
        "last_auto_started_scenario_key, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        INIT.cpId,
        "Charging",
        "Operative",
        null,
        JSON.stringify({
          id: 41,
          connectorId: 1,
          tagId: "LEGACY",
          meterStart: 100,
          meterStop: null,
          startTime: "2026-07-01T00:00:00.000Z",
          stopTime: null,
          meterSent: false,
        }),
        1500,
        null,
        null,
        "2026-07-01T00:10:00.000Z",
      ],
    );

    const svc = new CLIChargePointService({ ...INIT }, db);
    const resumed: Array<{ status: string; txId: number }> = [];
    const cp = priv(svc)._chargePoint;
    cp.loadBehavior({
      api: 1,
      id: "resumer",
      onResume: async (ctx) => {
        const connector = ctx.connector(1);
        resumed.push({
          status: String(connector?.status),
          txId: Number(connector?.transactionId ?? -1),
        });
      },
    });

    expect(svc.restoreConnectorRuntimeFromDatabase()).toBe(1);

    const record = cp.engine.state.connectors["1"];
    expect(record.status).toBe("Charging");
    expect(record.transaction).toMatchObject({
      id: 41,
      tagId: "LEGACY",
      startTime: "2026-07-01T00:00:00.000Z",
      stopTime: null,
    });
    // The connector reads the same state back, with Dates.
    const connector = cp.connectors.get(1)!;
    expect(connector.transaction?.startTime).toEqual(
      new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(connector.hasRunningTransaction).toBe(true);
    expect(connector.meterValue).toBe(1500);
    // onResume ran after the restore, and saw the restored state.
    return Promise.resolve().then(() => {
      expect(resumed).toEqual([{ status: "Charging", txId: 41 }]);
    });
  });

  it("round-trips the engine record through the row", () => {
    const db = freshDb();
    const boot1 = new CLIChargePointService({ ...INIT }, db);
    const c1 = priv(boot1)._chargePoint.connectors.get(1)!;
    c1.beginTransaction({
      id: 7,
      connectorId: 1,
      tagId: "RT",
      meterStart: 0,
      meterStop: null,
      startTime: new Date("2026-07-02T00:00:00.000Z"),
      stopTime: null,
      meterSent: false,
      cpTransactionId: "uuid-1",
      cpNextSeqNo: 3,
    });
    priv(boot1).persistConnectorRuntime(c1, 1);
    const saved = priv(boot1)._chargePoint.engine.state.connectors["1"];

    const boot2 = new CLIChargePointService({ ...INIT }, db);
    expect(boot2.restoreConnectorRuntimeFromDatabase()).toBe(1);
    expect(priv(boot2)._chargePoint.engine.state.connectors["1"]).toEqual(
      saved,
    );
  });
});
