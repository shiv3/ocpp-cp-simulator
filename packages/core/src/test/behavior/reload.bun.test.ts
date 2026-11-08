import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { ChargerEngine } from "../../cp/application/engine/ChargerEngine";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

async function start(behaviors: Behavior[]): Promise<BehaviorRun> {
  const run = await runBehavior({ version: "1.6", behaviors, seed: "reload" });
  runs.push(run);
  return run;
}

const resetAs = (id: string, status: string, delayMs = 0): Behavior => ({
  api: 1,
  id,
  onCall: {
    Reset: {
      mode: "replace",
      handle: async (_req, ctx) => {
        if (delayMs > 0) await ctx.sleep(delayMs);
        return { response: { status } };
      },
    },
  },
});

describe("replaceBehavior", () => {
  test("new CALLs use the new code", async () => {
    const run = await start([resetAs("b", "Accepted")]);
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Accepted",
    });
    run.cp.engine.replaceBehavior(resetAs("b", "Rejected"));
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Rejected",
    });
  });

  test("an exchange in flight finishes on the old code", async () => {
    const run = await start([resetAs("b", "Accepted", 2_000)]);
    const first = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.engine.replaceBehavior(resetAs("b", "Rejected"));
    // A CALL that arrives now is the new code's, even while the old one waits.
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Rejected",
    });
    await run.advance(2_000);
    const answer = run
      .frames()
      .find((f) => f.dir === "CP>" && f.kind === "result" && f.id === first);
    expect(answer?.payload).toEqual({ status: "Accepted" });
  });

  test("ctx.state survives", async () => {
    const counter = (id: string): Behavior => ({
      api: 1,
      id,
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_r, ctx) => {
            ctx.state.n = Number(ctx.state.n ?? 0) + 1;
            return { response: { status: "Accepted" } };
          },
        },
      },
    });
    const run = await start([counter("c")]);
    await run.call("Reset", { type: "Soft" });
    await run.call("Reset", { type: "Soft" });
    run.cp.engine.replaceBehavior(counter("c"));
    await run.call("Reset", { type: "Soft" });
    expect(run.cp.engine.snapshot().behaviors.c).toEqual({ n: 3 });
  });

  test("a running main sees ctx.stopping and the new main starts after it returns", async () => {
    const log: string[] = [];
    const looping = (tag: string): Behavior => ({
      api: 1,
      id: "m",
      main: async (ctx) => {
        log.push(`${tag} start`);
        while (!ctx.stopping) await ctx.sleep(1_000);
        log.push(`${tag} sees stopping`);
        await ctx.sleep(500); // still works during the grace time
        log.push(`${tag} done`);
      },
    });
    const run = await start([looping("v1")]);
    await run.advance(2_500);
    run.cp.engine.replaceBehavior(looping("v2"));
    await run.advance(0);
    expect(log).toEqual(["v1 start"]);
    await run.advance(500);
    expect(log).toContain("v1 sees stopping");
    await run.advanceInSteps(1_000, 250);
    expect(log).toEqual([
      "v1 start",
      "v1 sees stopping",
      "v1 done",
      "v2 start",
    ]);
  });

  test("a main that does not return is cut off after the grace time, then the new main starts", async () => {
    const log: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "hang",
        main: async (ctx) => {
          log.push("v1 start");
          try {
            await ctx.sleep(10 * 60_000);
          } catch {
            log.push("v1 cut off");
            throw new Error("cut");
          }
        },
      },
    ]);
    await run.advance(1_000);
    run.cp.engine.replaceBehavior({
      api: 1,
      id: "hang",
      main: async () => {
        log.push("v2 start");
      },
    });
    await run.advance(ChargerEngine.RELOAD_GRACE_MS - 1);
    expect(log).toEqual(["v1 start"]);
    await run.advance(1);
    expect(log).toEqual(["v1 start", "v1 cut off", "v2 start"]);
  });

  test("a version the station cannot take throws and the old one keeps running", async () => {
    const run = await start([resetAs("b", "Accepted")]);
    expect(() =>
      run.cp.engine.replaceBehavior({
        api: 1,
        id: "b",
        requires: ["ocpp2.x"],
      }),
    ).toThrow(/requires ocpp2.x/);
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Accepted",
    });
    expect(() => run.cp.engine.replaceBehavior(resetAs("other", "x"))).toThrow(
      /No behavior with id "other"/,
    );
  });

  test("hooks and beforeSend switch to the new version", async () => {
    const versioned = (tag: string): Behavior => ({
      api: 1,
      id: "h",
      on: {
        connectorStatus: (_e, ctx) => {
          ctx.state.last = tag;
        },
      },
      beforeSend: {
        StatusNotification: (p) => ({ ...p, info: tag }),
      },
    });
    const run = await start([versioned("v1")]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      info: "v1",
    });
    expect(run.cp.engine.snapshot().behaviors.h).toEqual({ last: "v1" });
    run.cp.engine.replaceBehavior(versioned("v2"));
    run.cp.updateConnectorStatus(1, "Available" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      info: "v2",
    });
    expect(run.cp.engine.snapshot().behaviors.h).toEqual({ last: "v2" });
  });

  test("replacing with the same code puts nothing on the wire", async () => {
    const b = resetAs("b", "Accepted");
    const run = await start([b]);
    const before = run.frames().length;
    run.cp.engine.replaceBehavior(resetAs("b", "Accepted"));
    await run.settle();
    expect(run.frames().length).toBe(before);
  });
});
