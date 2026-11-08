import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";

const runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose();
});
describe("core half of the k6 comparison", () => {
  test("C7 ctx.state is read-only: the type says so and core refuses an assignment", async () => {
    let error: unknown = null;
    const b: Behavior = {
      api: 1,
      id: "b",
      main: async (ctx) => {
        try {
          // @ts-expect-error `state` is readonly in the contract
          ctx.state = { a: 1 };
        } catch (e) {
          error = e;
        }
        ctx.state.a = 1;
      },
    };
    const run = await runBehavior({ version: "1.6", behaviors: [b] });
    runs.push(run);
    expect(error).toBeInstanceOf(TypeError);
    expect(run.cp.engine.snapshot().behaviors["b"]).toEqual({ a: 1 });
  });
  test("(reference) core: ctx.random(name) continues; undefined handler => CALLERROR, rule free", async () => {
    const got: number[] = [];
    const b: Behavior = {
      api: 1,
      id: "b",
      onCall: {
        Reset: { mode: "replace", handle: (async () => undefined) as never },
      },
      main: async (ctx) => {
        for (let i = 0; i < 5; i++) got.push(ctx.random("j").int(0, 1_000_000));
      },
    };
    const run = await runBehavior({ version: "1.6", behaviors: [b] });
    runs.push(run);
    expect(new Set(got).size).toBe(5);
    const r1 = await run.call("Reset", { type: "Soft" });
    expect(r1.kind).toBe("error");
    expect(JSON.stringify(r1.payload)).toContain("InternalError");
    const r2 = await run.call("Reset", { type: "Soft" });
    expect(JSON.stringify(r2.payload)).toContain("InternalError");
  });
});
