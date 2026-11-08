import { afterEach, describe, expect, it } from "bun:test";
import type { ChargerEngine } from "@ocpp-cp-sim/core/cp/application/engine/ChargerEngine";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-sim/core/cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-sim/core/cp/domain/persistence/schema";
import { CLIChargePointService } from "../service";
import { CPRegistry } from "../server/CPRegistry";
import { EventBus } from "../server/eventBus";
import type { ChargePointInitOptions } from "../types";

const INIT: ChargePointInitOptions = {
  cpId: "cp-a",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const db0 = () => {
  const db = BunSqliteDatabase.open(":memory:");
  runMigrations(db);
  return db;
};
const row = (db: BunSqliteDatabase, id = INIT.cpId) => {
  const r = db.get<{ state_json: string }>(
    "SELECT state_json FROM engine_state WHERE cp_id = ?",
    [id],
  );
  return r ? JSON.parse(r.state_json) : null;
};
const engineOf = (s: CLIChargePointService) =>
  (s as unknown as { _chargePoint: { engine: ChargerEngine } })._chargePoint
    .engine;
const registries: CPRegistry[] = [];
const registry = (db: BunSqliteDatabase, behaviors: Behavior[]) => {
  const r = new CPRegistry(new EventBus(), db, { behaviors } as never);
  registries.push(r);
  return r;
};
afterEach(() => {
  for (const r of registries.splice(0)) {
    for (const id of r.list()) r.remove(id, { notify: false });
  }
});

describe("engine_state: what reaches the row", () => {
  it("A3 an async hook's write after its last await reaches the row", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    let hookDone = false;
    svc.loadBehaviors([
      {
        api: 1,
        id: "h",
        on: {
          async callReceived(_e, ctx) {
            await ctx.sleep(1);
            ctx.state.seen = true;
            hookDone = true;
          },
        },
      },
    ]);
    engineOf(svc).observe({
      type: "callReceived",
      action: "Reset",
      messageId: "1",
      payload: {},
    });
    await wait(30);
    expect(hookDone).toBe(true);
    expect(row(db)?.behaviors?.h).toEqual({ seen: true });
    svc.cleanup(true);
  });

  it("A3b a beforeSend's ctx.state write reaches the row", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    svc.loadBehaviors([
      {
        api: 1,
        id: "count",
        beforeSend: {
          Heartbeat: (_p, ctx) => {
            ctx.state.beats = Number(ctx.state.beats ?? 0) + 1;
          },
        },
      },
    ]);
    await wait();
    engineOf(svc).beforeSend("Heartbeat", {});
    await wait();
    expect(row(db)?.behaviors?.count).toEqual({ beats: 1 });
    svc.cleanup(true);
  });

  it("A12 an unloaded behavior's ctx.state does not come back from a still-running handler", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    let saved!: { state: Record<string, unknown> };
    svc.loadBehaviors([
      {
        api: 1,
        id: "g",
        main: async (ctx) => {
          saved = ctx;
          ctx.state.a = 1;
          await ctx.sleep(1_000_000);
        },
      },
    ]);
    await wait();
    svc.setBehaviors([], []);
    await wait();
    saved.state.ghost = 1;
    engineOf(svc).dispatch({
      type: "notified",
      kind: "log",
      status: "Uploaded",
    });
    await wait();
    expect(row(db)?.behaviors?.g).toBeUndefined();
    svc.cleanup(true);
  });
});

describe("behavior lifecycle across cp.update and unload", () => {
  it("A5 cp.update stops the old instance's main", async () => {
    const db = db0();
    const ticks: Record<string, number> = {};
    let instance = 0;
    const loop: Behavior = {
      api: 1,
      id: "loop",
      main: async (ctx) => {
        const me = `i${++instance}`;
        for (;;) {
          ticks[me] = (ticks[me] ?? 0) + 1;
          await ctx.sleep(5);
        }
      },
    };
    const reg = registry(db, [loop]);
    reg.create({ ...INIT }, { seedDefault: false });
    await wait(15);
    reg.update({ ...INIT, vendor: "v2" });
    await wait(10);
    const before = ticks.i1!;
    await wait(40);
    expect(ticks.i2).toBeGreaterThan(0);
    expect(ticks.i1).toBe(before);
  });

  it("A5b after cp.update the discarded instance does not overwrite the row", async () => {
    const db = db0();
    let n = 0;
    const writer: Behavior = {
      api: 1,
      id: "w",
      main: async (ctx) => {
        const me = ++n;
        for (let i = 0; ; i++) {
          ctx.state.owner = me;
          ctx.state.tick = i;
          await ctx.sleep(3);
        }
      },
    };
    const reg = registry(db, [writer]);
    reg.create({ ...INIT }, { seedDefault: false });
    await wait(10);
    reg.update({ ...INIT, vendor: "v2" });
    const owners = new Set<number>();
    for (let i = 0; i < 40; i++) {
      await wait(1);
      if (i > 5) owners.add(row(db).behaviors.w.owner);
    }
    expect([...owners]).toEqual([2]);
  });

  it("A11 unloading a behavior ends its onResume", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    let ticks = 0;
    svc.loadBehaviors([
      {
        api: 1,
        id: "r",
        onResume: async (ctx) => {
          for (;;) {
            ticks++;
            await ctx.sleep(3);
          }
        },
      },
    ]);
    svc.resumeEngine();
    await wait(10);
    svc.setBehaviors([], []);
    await wait(3);
    const at = ticks;
    await wait(30);
    expect(ticks).toBe(at);
    svc.cleanup(true);
  });
});
