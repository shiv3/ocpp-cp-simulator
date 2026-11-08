/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/domain/persistence/schema";
import { CLIChargePointService } from "../../service";
import { CPRegistry } from "../../server/CPRegistry";
import { EventBus } from "../../server/eventBus";
import type { ChargePointInitOptions } from "../../types";

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
const engineOf = (s: CLIChargePointService) => (s as any)._chargePoint.engine;
const registries: CPRegistry[] = [];
const registry = (db: BunSqliteDatabase, behaviors: Behavior[]) => {
  const r = new CPRegistry(new EventBus(), db, { behaviors } as any);
  registries.push(r);
  return r;
};
afterEach(() => {
  for (const r of registries.splice(0)) {
    for (const id of r.list()) r.remove(id, { notify: false });
  }
});

describe("engine_state robustness", () => {
  it("A1 ctx.state.x = undefined in one behavior does not stop every later save", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    svc.loadBehaviors([
      {
        api: 1,
        id: "good",
        main: async (ctx) => {
          ctx.state.n = 1;
          await ctx.sleep(1);
        },
      },
      {
        api: 1,
        id: "clears",
        main: async (ctx) => {
          (ctx.state as any).pending = undefined;
          await ctx.sleep(1);
        },
      },
    ]);
    await wait();
    engineOf(svc).dispatch({
      type: "notified",
      kind: "firmware",
      status: "Installing",
    });
    await wait();
    expect(row(db)?.firmware?.status).toBe("Installing");
    expect(row(db)?.behaviors?.good).toEqual({ n: 1 });
    svc.cleanup(true);
  });

  it("A1b a Date in one behavior's ctx.state does not stop the other behaviors' persistence", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    svc.loadBehaviors([
      {
        api: 1,
        id: "good",
        main: async (ctx) => {
          ctx.state.n = 1;
          await ctx.sleep(1);
        },
      },
      {
        api: 1,
        id: "date",
        main: async (ctx) => {
          (ctx.state as any).when = new Date();
          await ctx.sleep(1);
        },
      },
    ]);
    await wait();
    expect(row(db)?.behaviors?.good).toEqual({ n: 1 });
    svc.cleanup(true);
  });

  it("A2 a behavior with no main keeps its stored ctx.state across a load and a crash", async () => {
    const db = db0();
    const rule: Behavior = {
      api: 1,
      id: "rules-only",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_req, ctx) => {
            ctx.state.resets = Number(ctx.state.resets ?? 0) + 1;
            return { response: { status: "Accepted" } };
          },
        },
      },
    };
    db.run(
      "INSERT INTO engine_state (cp_id, state_json, updated_at) VALUES (?, ?, ?)",
      [
        INIT.cpId,
        JSON.stringify({
          schema: 1,
          firmware: { status: "Idle", requestId: null },
          signedFirmware: { status: "Idle", requestId: null },
          log: { status: "Idle", requestId: null },
          diagnostics: { status: "Idle" },
          behaviors: { "rules-only": { resets: 7 } },
        }),
        "2026-11-01T00:00:00Z",
      ],
    );
    const svc = new CLIChargePointService({ ...INIT }, db);
    svc.loadBehaviors([rule]);
    await wait();
    // The process is killed here: what is in the row is what the next start sees.
    expect(row(db).behaviors["rules-only"]).toEqual({ resets: 7 });
  });

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

  it("A4 a behavior id starting with default. is refused at load, so no ctx.state is silently dropped", () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    expect(() =>
      svc.loadBehaviors([{ api: 1, id: "default.my-site" }]),
    ).toThrow(/reserved/);
    svc.cleanup(true);
  });
});

describe("registry lifecycle", () => {
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

  it("A6 a deleted charge point leaves no engine_state row", async () => {
    const db = db0();
    const b: Behavior = {
      api: 1,
      id: "b",
      main: async (ctx) => {
        try {
          await ctx.sleep(1_000_000);
        } finally {
          ctx.state.stopped = true;
        }
      },
    };
    const reg = registry(db, [b]);
    reg.create({ ...INIT }, { seedDefault: false });
    await wait();
    reg.remove(INIT.cpId);
    await wait();
    expect(row(db)).toBeNull();
  });

  it("A7 one charge point that cannot run a loaded behavior does not take the restore down", async () => {
    const db = db0();
    const first = registry(db, []);
    first.create({ ...INIT, cpId: "ok-before" }, { seedDefault: false });
    first.create({ ...INIT, cpId: "ok-after" }, { seedDefault: false });
    first.shutdownAll();
    // The next start is given a behavior for 2.x; the rows above are 1.6.
    const v2: Behavior = { api: 1, id: "v2only", requires: ["ocpp2.x"] };
    const next = registry(db, [v2]);
    let restored: string[] = [];
    let error: unknown = null;
    try {
      restored = next.restoreFromDatabase({ connect: false });
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(restored.sort()).toEqual(["ok-after", "ok-before"]);
  });

  it("A8 a selection the station refuses is not persisted", async () => {
    const db = db0();
    const plain: Behavior = { api: 1, id: "plain" };
    const v2: Behavior = { api: 1, id: "v2only", requires: ["ocpp2.x"] };
    const reg = registry(db, [plain, v2]);
    reg.create({ ...INIT, behaviors: ["plain"] }, { seedDefault: false });
    expect(() => reg.setBehaviors(INIT.cpId, ["v2only"])).toThrow();
    const stored = db.get<{ behaviors: string }>(
      "SELECT behaviors FROM charge_points WHERE cp_id = ?",
      [INIT.cpId],
    );
    expect(JSON.parse(stored!.behaviors)).toEqual(["plain"]);
  });

  it("A8b the daemon still restarts after a refused cp.behaviors.set", async () => {
    const db = db0();
    const plain: Behavior = { api: 1, id: "plain" };
    const v2: Behavior = { api: 1, id: "v2only", requires: ["ocpp2.x"] };
    const reg = registry(db, [plain, v2]);
    reg.create({ ...INIT, behaviors: ["plain"] }, { seedDefault: false });
    expect(() => reg.setBehaviors(INIT.cpId, ["v2only"])).toThrow();
    reg.shutdownAll();
    const next = registry(db, [plain, v2]);
    expect(next.restoreFromDatabase({ connect: false })).toEqual([INIT.cpId]);
  });

  it("A9 cp.create that cannot load leaves no half-created charge point", async () => {
    const db = db0();
    const v2: Behavior = { api: 1, id: "v2only", requires: ["ocpp2.x"] };
    const reg = registry(db, [v2]);
    expect(() =>
      reg.create({ ...INIT, behaviors: ["v2only"] }, { seedDefault: false }),
    ).toThrow();
    expect(reg.list()).toEqual([]);
    expect(
      db.get("SELECT cp_id FROM charge_points WHERE cp_id = ?", [INIT.cpId]),
    ).toBeNull();
  });

  it("A10 a selection id missing from one run survives a cp.update in that run", async () => {
    const db = db0();
    const a: Behavior = { api: 1, id: "a" };
    const b: Behavior = { api: 1, id: "b" };
    const first = registry(db, [a, b]);
    first.create({ ...INIT, behaviors: ["a", "b"] }, { seedDefault: false });
    first.shutdownAll();
    const second = registry(db, [a]); // started with fewer --behavior files
    second.restoreFromDatabase({ connect: false });
    second.update({ ...INIT, vendor: "v2" });
    const stored = db.get<{ behaviors: string }>(
      "SELECT behaviors FROM charge_points WHERE cp_id = ?",
      [INIT.cpId],
    );
    expect(JSON.parse(stored!.behaviors)).toEqual(["a", "b"]);
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

  it("A12 an unloaded behavior's ctx.state does not come back from a still-running handler", async () => {
    const db = db0();
    const svc = new CLIChargePointService({ ...INIT }, db);
    let saved: any;
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

  it("A13 multi-station: rows are per charge point", async () => {
    const db = db0();
    const b: Behavior = {
      api: 1,
      id: "b",
      main: async (ctx) => {
        ctx.state.me = ctx.charger.id;
        await ctx.sleep(1);
      },
    };
    const reg = registry(db, [b]);
    reg.create({ ...INIT, cpId: "x" }, { seedDefault: false });
    reg.create({ ...INIT, cpId: "y" }, { seedDefault: false });
    await wait();
    expect(row(db, "x").behaviors.b).toEqual({ me: "x" });
    expect(row(db, "y").behaviors.b).toEqual({ me: "y" });
  });
});
