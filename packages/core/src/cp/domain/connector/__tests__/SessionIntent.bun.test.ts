import { describe, expect, it } from "bun:test";

import type { ChargePoint } from "../../charge-point/ChargePoint";
import { createChargePoint } from "../../../infrastructure/charge-point/createChargePoint";
import { BunSqliteDatabase } from "../../../infrastructure/persistence/BunSqliteDatabase";
import { SqliteConnectorRuntimeRepository } from "../../../infrastructure/persistence/SqliteConnectorRuntimeRepository";
import { DefaultBootNotification, OCPPStatus } from "../../types/OcppTypes";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";

/**
 * `Transaction.targetSoc` and `Transaction.stopAtTarget` have one writer, the
 * `startTransaction` options (#327), and survive a restart through the
 * `connector_runtime.transaction_json` column. No migration: the column holds
 * the whole transaction.
 */
function makeChargePoint(): ChargePoint {
  return createChargePoint(
    "cp-intent",
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:65534/never",
    null,
    null,
  );
}

describe("session intent on the transaction (#327)", () => {
  it("startTransaction writes initialSoc, targetSoc and stopAtTarget", async () => {
    const cp = makeChargePoint();
    const outcome = await cp.startTransaction("TAG", 1, undefined, 25, {
      triggerReason: "RemoteStart",
      targetSoc: 70,
      stopAtTarget: true,
    });
    expect(outcome.started).toBe(true);
    const tx = cp.getConnector(1)!.transaction!;
    expect(tx.initialSoc).toBe(25);
    expect(tx.targetSoc).toBe(70);
    expect(tx.stopAtTarget).toBe(true);
    expect(cp.getConnector(1)!.sessionIntent()).toEqual({
      initialSoc: 25,
      targetSoc: 70,
      stopAtTarget: true,
    });
  });

  it("leaves the fields absent when the start names none", async () => {
    const cp = makeChargePoint();
    await cp.startTransaction("TAG", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    const tx = cp.getConnector(1)!.transaction!;
    expect("targetSoc" in tx).toBe(false);
    expect("stopAtTarget" in tx).toBe(false);
  });

  it("restores the target through the connector_runtime row", async () => {
    const cp = makeChargePoint();
    await cp.startTransaction("TAG", 1, undefined, 25, {
      triggerReason: "RemoteStart",
      targetSoc: 70,
      stopAtTarget: true,
    });
    const snapshot = cp.getConnector(1)!.snapshotRuntime();

    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new SqliteConnectorRuntimeRepository(db);
      repo.save("cp-intent", 1, snapshot);
      const loaded = repo.load("cp-intent", 1)!;

      const restored = new Connector(1, new Logger(LogLevel.ERROR));
      restored.restoreRuntimeSnapshot(loaded);
      expect(restored.transaction?.targetSoc).toBe(70);
      expect(restored.transaction?.stopAtTarget).toBe(true);
      expect(restored.sessionIntent()).toEqual({
        initialSoc: 25,
        targetSoc: 70,
        stopAtTarget: true,
      });
    } finally {
      db.close();
    }
  });

  it("stops at the session's target, not the connector's default, without stopAtTargetSoc set", async () => {
    const cp = makeChargePoint();
    const connector = cp.getConnector(1)!;
    connector.evSettings = {
      ...connector.evSettings,
      batteryCapacityKwh: 100,
      targetSoc: 95,
    };
    await cp.startTransaction("TAG", 1, undefined, 20, {
      triggerReason: "RemoteStart",
      targetSoc: 60,
      stopAtTarget: true,
    });
    connector.status = OCPPStatus.Charging;
    let stops = 0;
    connector.events.on("autoStopRequested", () => (stops += 1));
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 1,
      incrementValue: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 4_300));
    // 20 % -> 60 % of 100 kWh = 40 kWh = four 10 kWh ticks.
    expect(connector.meterValue).toBe(40_000);
    expect(stops).toBe(1);
  }, 10_000);
});
