/* eslint-disable */
import { describe, expect, it } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { EventBus } from "../../server/eventBus";
import { CPRegistry } from "../../server/CPRegistry";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";

const a: Behavior = { api: 1, id: "a" };
const c: Behavior = { api: 1, id: "c" };
const INIT = {
  cpId: "P",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
} as any;
function db() {
  const d = BunSqliteDatabase.open(":memory:");
  runMigrations(d);
  return d;
}
const reg = (d: any, bs: Behavior[]) =>
  new CPRegistry(new EventBus(), d, { behaviors: BehaviorLibrary.of(bs) });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("stored selection", () => {
  it("cp.update on a station restored without one file does not erase that id from the row", () => {
    const d = db();
    const r1 = reg(d, [a, c]);
    r1.create({ ...INIT, behaviors: ["a", "c"] }, { seedDefault: false });
    r1.shutdownAll();
    const r2 = reg(d, [a]); // restarted once without c.ts
    r2.restoreFromDatabase({ connect: false });
    r2.update({ ...INIT, vendor: "v2" }); // edit the vendor in the console
    r2.shutdownAll();
    const r3 = reg(d, [a, c]); // c.ts is back
    r3.restoreFromDatabase({ connect: false });
    expect(r3.get("P")!.behaviorIds()).toEqual(["a", "c"]);
    r3.shutdownAll();
  });

  it("a stored selection that cannot be read fails closed: it does not run every behavior", () => {
    const d = db();
    const r1 = reg(d, [a, c]);
    r1.create({ ...INIT, behaviors: [] }, { seedDefault: false });
    r1.shutdownAll();
    d.run("UPDATE charge_points SET behaviors = ? WHERE cp_id = ?", [
      '["a"',
      "P",
    ]);
    const r2 = reg(d, [a, c]);
    r2.restoreFromDatabase({ connect: false });
    expect(r2.get("P")!.behaviorIds()).not.toEqual(["a", "c"]);
    r2.shutdownAll();
  });
});

describe("ctx.state across a rebuild", () => {
  const counter = (): Behavior => ({
    api: 1,
    id: "n",
    main: async (ctx) => {
      ctx.state.n = ((ctx.state.n as number) ?? 0) + 1;
      await ctx.sleep(10_000_000);
    },
  });
  it("with no --state-db, cp.update keeps ctx.state as it keeps scenarios", async () => {
    const r = reg(null, [counter()]);
    r.create(INIT, { seedDefault: false });
    await tick();
    r.update({ ...INIT, vendor: "v2" });
    await tick();
    const state = (r.get("P") as any)._chargePoint.engine.state.behaviors.n;
    r.shutdownAll();
    expect(state.n).toBe(2);
  });

  it("a station that was deleted leaves no engine_state row, even if its main wrote while stopping", async () => {
    const d = db();
    const b: Behavior = {
      api: 1,
      id: "n",
      main: async (ctx) => {
        ctx.state.n = 1;
        try {
          await ctx.sleep(10_000_000);
        } finally {
          ctx.state.bye = true;
        }
      },
    };
    const r = reg(d, [b]);
    r.create(INIT, { seedDefault: false });
    await tick();
    r.remove("P");
    await tick();
    const row = d.get("SELECT state_json FROM engine_state WHERE cp_id = ?", [
      "P",
    ]);
    expect(row ?? null).toBeNull();
    r.shutdownAll();
  });
  it("a new station under a deleted id starts with empty ctx.state", async () => {
    const d = db();
    const b: Behavior = {
      api: 1,
      id: "n",
      main: async (ctx) => {
        ctx.state.n = ((ctx.state.n as number) ?? 0) + 1;
        try {
          await ctx.sleep(10_000_000);
        } finally {
          ctx.state.bye = true;
        }
      },
    };
    const r = reg(d, [b]);
    r.create(INIT, { seedDefault: false });
    await tick();
    r.remove("P");
    await tick();
    r.create(INIT, { seedDefault: false });
    await tick();
    const state = (r.get("P") as any)._chargePoint.engine.state.behaviors.n;
    r.shutdownAll();
    expect(state).toEqual({ n: 1 });
  });
});
