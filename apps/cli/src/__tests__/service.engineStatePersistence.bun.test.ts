import { describe, expect, it } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";

// The engine's own state (notification statuses and the ctx.state of
// behaviors) survives a restart in the engine_state row; old databases load.
const INIT: ChargePointInitOptions = {
  cpId: "engine-state-cp",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
};

interface Engine {
  bootAccepted(): void;
  state: {
    firmware: { status: string; requestId: number | null };
    behaviors: Record<string, Record<string, unknown>>;
  };
  persistable(): unknown;
  dispatch(event: unknown): void;
}
const engineOf = (svc: CLIChargePointService): Engine =>
  (svc as unknown as { _chargePoint: { engine: Engine } })._chargePoint.engine;

const counter = (seen: unknown[]): Behavior => ({
  api: 1,
  id: "counter",
  async main(ctx) {
    ctx.state.runs = Number(ctx.state.runs ?? 0) + 1;
    await ctx.sleep(1);
  },
  async onResume(ctx) {
    seen.push({ ...ctx.state });
  },
});

const rows = (db: BunSqliteDatabase) =>
  db.all<{ cp_id: string; state_json: string }>(
    "SELECT cp_id, state_json FROM engine_state",
  );

describe("engine state persistence", () => {
  it("writes nothing for a charge point that never changed it", () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    new CLIChargePointService({ ...INIT }, db);
    expect(rows(db)).toEqual([]);
  });

  it("restores ctx.state and the notification statuses", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);

    const first = new CLIChargePointService({ ...INIT }, db);
    first.loadBehaviors([counter([])]);
    engineOf(first).dispatch({
      type: "notified",
      kind: "firmware",
      status: "Installing",
      requestId: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rows(db)).toHaveLength(1);
    expect(JSON.parse(rows(db)[0]!.state_json).behaviors.counter).toEqual({
      runs: 1,
    });

    const seen: unknown[] = [];
    const second = new CLIChargePointService({ ...INIT }, db);
    expect(engineOf(second).state.firmware).toEqual({
      status: "Installing",
      requestId: 5,
    });
    second.loadBehaviors([counter(seen)]);
    second.resumeEngine();
    engineOf(second).bootAccepted();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // onResume saw the stored state; main ran once more on top of it.
    expect(seen).toEqual([{ runs: 2 }]);
    expect(JSON.parse(rows(db)[0]!.state_json).behaviors.counter).toEqual({
      runs: 2,
    });
  });

  it("keeps the data of a behavior that is not loaded this run", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    const first = new CLIChargePointService({ ...INIT }, db);
    first.loadBehaviors([counter([])]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const without = new CLIChargePointService({ ...INIT }, db);
    engineOf(without).dispatch({
      type: "notified",
      kind: "log",
      status: "Uploaded",
    });
    expect(JSON.parse(rows(db)[0]!.state_json).behaviors.counter).toEqual({
      runs: 1,
    });

    const third = new CLIChargePointService({ ...INIT }, db);
    third.loadBehaviors([counter([])]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engineOf(third).state.behaviors.counter).toEqual({ runs: 2 });
  });

  it("ignores a stored value it cannot read", () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    for (const text of ["not json", '{"schema":9}', "[]", '"x"']) {
      db.run(
        "INSERT OR REPLACE INTO engine_state (cp_id, state_json, updated_at) VALUES (?, ?, ?)",
        [INIT.cpId, text, "2026-11-01T00:00:00Z"],
      );
      const svc = new CLIChargePointService({ ...INIT }, db);
      expect(engineOf(svc).state.firmware.status).toBe("Idle");
    }
  });

  it("loads a database written before the table existed", () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE engine_state");
    db.run("UPDATE schema_meta SET value = '22' WHERE key = 'version'");
    runMigrations(db);
    const svc = new CLIChargePointService({ ...INIT }, db);
    expect(engineOf(svc).state.firmware.status).toBe("Idle");
  });

  it("does not persist the ctx.state of a behavior that holds non-JSON", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    runMigrations(db);
    const svc = new CLIChargePointService({ ...INIT }, db);
    svc.loadBehaviors([
      {
        api: 1,
        id: "bad",
        main(ctx) {
          (ctx.state as Record<string, unknown>).when = new Date();
          return ctx.sleep(1);
        },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The failure is a warning, not a crash, and the last good row stays.
    expect(JSON.parse(rows(db)[0]!.state_json).behaviors.bad).toEqual({});
  });
});
