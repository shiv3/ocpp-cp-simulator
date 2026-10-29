// Runs under `bun test`: the repository is exercised on the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "../../persistence/BunSqliteDatabase";
import { VariableMonitorRepository } from "../VariableMonitorRepository";
import type { VariableMonitor } from "../VariableMonitor";
import { ChargePoint } from "../../charge-point/ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";

/** #457: the `variable_monitors` table behind N07.FR.13 / FR.14. */

const opened: BunSqliteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(): BunSqliteDatabase {
  const db = BunSqliteDatabase.open(":memory:");
  opened.push(db);
  return db;
}

function monitor(overrides: Partial<VariableMonitor> = {}): VariableMonitor {
  return {
    id: 1,
    type: "UpperThreshold",
    severity: 4,
    value: 600,
    transaction: false,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    origin: "CustomMonitor",
    ...overrides,
  };
}

describe("VariableMonitorRepository", () => {
  it("round-trips monitors by id with their triggered flag", () => {
    const repo = new VariableMonitorRepository("CP-A", openDb());
    repo.save(monitor({ id: 2, type: "Delta", value: 5 }));
    repo.save(monitor());
    repo.setTriggered(1, true);

    expect(repo.load()).toEqual([
      { monitor: monitor(), triggered: true },
      {
        monitor: monitor({ id: 2, type: "Delta", value: 5 }),
        triggered: false,
      },
    ]);
  });

  it("keeps the triggered flag when a monitor is saved again (replace by id)", () => {
    const repo = new VariableMonitorRepository("CP-A", openDb());
    repo.save(monitor());
    repo.setTriggered(1, true);
    repo.save(monitor({ value: 700 }));

    expect(repo.load()).toEqual([
      { monitor: monitor({ value: 700 }), triggered: true },
    ]);
  });

  it("keeps two charge points apart", () => {
    const db = openDb();
    const a = new VariableMonitorRepository("CP-A", db);
    const b = new VariableMonitorRepository("CP-B", db);
    a.save(monitor());
    b.save(monitor());
    b.save(monitor({ id: 2 }));

    a.setTriggered(1, true);
    b.delete(2);

    expect(a.load()).toEqual([{ monitor: monitor(), triggered: true }]);
    expect(b.load()).toEqual([{ monitor: monitor(), triggered: false }]);
    b.delete(1);
    expect(a.load()).toHaveLength(1);
    expect(b.load()).toEqual([]);
  });

  it("skips rows it cannot read instead of failing", () => {
    const db = openDb();
    for (const [id, raw] of [
      [1, "not json"],
      [2, "null"],
      [3, JSON.stringify({ ...monitor({ id: 3 }), type: "Periodic" })],
      [4, JSON.stringify({ ...monitor({ id: 4 }), component: undefined })],
      [5, JSON.stringify(monitor({ id: 5 }))],
    ] as const) {
      db.run(
        "INSERT INTO variable_monitors (cp_id, monitor_id, monitor) VALUES ('CP-A', ?, ?)",
        [id, raw],
      );
    }
    const repo = new VariableMonitorRepository("CP-A", db);
    expect(repo.load().map((p) => p.monitor.id)).toEqual([5]);
  });

  it("does nothing without a database", () => {
    const repo = new VariableMonitorRepository("CP-A", null);
    repo.save(monitor());
    repo.setTriggered(1, true);
    repo.delete(1);
    expect(repo.load()).toEqual([]);
  });
});

describe("ChargePoint variable-monitor persistence", () => {
  it("stores the triggered flag of a monitor installed beyond its threshold", () => {
    const db = openDb();
    const cp = new ChargePoint(
      "CP-PERSIST",
      DefaultBootNotification,
      1,
      "ws://127.0.0.1:1/ocpp",
      null,
      null,
      db,
      {},
      [],
      "OCPP-2.0.1",
      {},
    );
    // The flag records what the CSMS was told, so the boot is Accepted
    // first (B02.FR.02).
    cp.onBootNotificationResult({
      status: "Accepted",
      interval: 0,
      currentTime: "2026-10-29T00:00:00.000Z",
    });
    // HeartbeatInterval defaults to 300, above this threshold: the
    // monitor triggers as it is installed, before any value change.
    cp.monitoring.install({
      type: "UpperThreshold",
      severity: 4,
      value: 100,
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
      valueKey: "HeartbeatInterval",
      valueType: { numeric: true },
    });

    expect(
      new VariableMonitorRepository("CP-PERSIST", db)
        .load()
        .map((p) => [p.monitor.id, p.triggered]),
    ).toEqual([[1, true]]);
  });
});
