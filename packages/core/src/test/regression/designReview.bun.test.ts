// Decisions of the design review (S1, S3, S4, S8): see docs/concepts/charger-engine.md.
import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});
const start = async (o: Parameters<typeof runBehavior>[0]) => {
  const r = await runBehavior(o);
  runs.push(r);
  return r;
};

describe("S3: requires is a closed set; virtual-time is gone", () => {
  test("a station on a virtual clock and on a real one refuse the same unknown capability", async () => {
    const run = await start({ version: "1.6" });
    const b = {
      api: 1,
      id: "v",
      requires: ["virtual-time"],
    } as unknown as Behavior;
    expect(() => run.cp.loadBehavior(b)).toThrow(/not a capability/);
  });
});

describe("S4: a state that cannot be stored fails the harness", () => {
  test("a Date in ctx.state throws at the settle that follows the write", async () => {
    const b: Behavior = {
      api: 1,
      id: "dates",
      main: async (ctx) => {
        (ctx.state as Record<string, unknown>).when = new Date(0);
        await ctx.sleep(1);
      },
    };
    await expect(start({ version: "1.6", behaviors: [b] })).rejects.toThrow(
      /ctx\.state of dates/,
    );
  });
  test("a key set to undefined is fine", async () => {
    const b: Behavior = {
      api: 1,
      id: "clear",
      main: async (ctx) => {
        ctx.state.x = 1;
        (ctx.state as Record<string, unknown>).x = undefined;
        await ctx.sleep(1);
      },
    };
    const run = await start({ version: "1.6", behaviors: [b] });
    await run.advance(5);
  });
});

describe("S8: a rule is busy until its CALL is answered, not until `after` ends", () => {
  test("a second CALL is served while the first one's after still runs", async () => {
    const b: Behavior = {
      api: 1,
      id: "slow-after",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_r, ctx) => ({
            response: ctx.accepted("Reset"),
            after: () => new Promise<void>(() => {}), // never ends
          }),
        },
      },
    };
    const run = await start({ version: "1.6", behaviors: [b] });
    const first = await run.call("Reset", { type: "Soft" });
    const second = await run.call("Reset", { type: "Soft" });
    expect(first.kind).toBe("result");
    expect(second.kind).toBe("result");
  });
});
