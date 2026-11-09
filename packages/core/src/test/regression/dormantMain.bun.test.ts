// Design: a dormant behavior has "no rules, no main"; useBehavior registers its
// rules "under the run as owner, so they end with the run". 08871547 starts the
// dormant behavior's main on the first activation, and nothing stops it when the
// run ends: it keeps sending.
import { afterEach, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

test("the main a useBehavior started does not outlive the run", async () => {
  const b: Behavior = {
    api: 1,
    id: "d",
    main: async (ctx) => {
      for (;;) {
        await ctx.sleep(1000);
        await ctx.send("Heartbeat", {});
      }
    },
  };
  const run = await runBehavior({ version: "1.6", seed: "x" });
  runs.push(run);
  run.cp.loadBehavior(b, { dormant: true });
  const owner = {
    kind: "scenario",
    scenarioId: "s",
    connectorId: 1,
    nodeId: "n",
  } as const;
  run.cp.engine.activateBehavior("d", owner);
  await run.advanceInSteps(3000, 500);
  // the run ends: ScenarioRuntime releases what it owns
  const ends = (o: { kind: string; scenarioId?: string }): boolean =>
    o.kind === "scenario" && o.scenarioId === "s";
  run.cp.behaviors.release(ends);
  run.cp.engine.deactivateBehaviors(ends);
  await run.settle();
  const before = run.callsOf("Heartbeat").length;
  await run.advanceInSteps(10_000, 500);
  const after = run.callsOf("Heartbeat").length;
  console.log("heartbeats during run", before, "after run end", after - before);
  expect(after - before).toBe(0);
});

test("a dormant behavior is all or none: hooks and beforeSend follow the holder", async () => {
  const seen: string[] = [];
  const dormant: Behavior = {
    api: 1,
    id: "d2",
    on: { callResult: (e) => void seen.push(e.action) },
    beforeSend: { Heartbeat: () => ({ drop: true }) },
  };
  const driver: Behavior = {
    api: 1,
    id: "drv",
    main: async (ctx) => {
      for (;;) {
        await ctx.sleep(1000);
        try {
          await ctx.send("Heartbeat", {});
        } catch {
          // dropped by a beforeSend
        }
      }
    },
  };
  const run = await runBehavior({
    version: "1.6",
    seed: "x",
    behaviors: [driver],
  });
  runs.push(run);
  run.cp.loadBehavior(dormant, { dormant: true });
  const owner = {
    kind: "scenario",
    scenarioId: "t",
    connectorId: 1,
    nodeId: "n",
  } as const;
  await run.advanceInSteps(3000, 500);
  const idle = run.callsOf("Heartbeat").length;
  expect(idle).toBeGreaterThan(0); // idle: no beforeSend
  expect(seen).toEqual([]); // idle: no hook
  run.cp.engine.activateBehavior("d2", owner);
  await run.advanceInSteps(3000, 500);
  expect(run.callsOf("Heartbeat").length).toBe(idle); // held: dropped
  run.cp.engine.deactivateBehaviors(
    (o) => o.kind === "scenario" && o.scenarioId === "t",
  );
  await run.advanceInSteps(3000, 500);
  expect(run.callsOf("Heartbeat").length).toBeGreaterThan(idle); // let go: idle again
});
