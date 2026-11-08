// The test that ships with the template. Runs under `bun test`.
import { afterEach, describe, expect, test } from "bun:test";
import {
  runBehavior,
  type BehaviorRun,
} from "../../packages/core/src/test/behavior/runBehavior";
import { disconnectOnCharging } from "./disconnect-on-charging";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

async function charging(seed: string): Promise<BehaviorRun> {
  const run = await runBehavior({
    version: "1.6",
    seed,
    behaviors: [
      disconnectOnCharging,
      {
        api: 1,
        id: "driver",
        requires: ["physical"],
        main: async (ctx) => {
          ctx.plugIn(1);
          await ctx.sleep(500);
          ctx.startCharging(1, "TAG");
        },
      },
    ],
  });
  runs.push(run);
  await run.advanceInSteps(5_000, 250);
  return run;
}

describe("disconnect-on-charging", () => {
  test("misbehaves once the connector is charging", async () => {
    const run = await charging("seed-1");
    expect(
      run.cp.engine.snapshot().behaviors["disconnect-on-charging"].misbehaved,
    ).toBe(1);
  });

  test("adds the offset to the readings of every MeterValues", async () => {
    const run = await charging("seed-2");
    await run.call("TriggerMessage", {
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    await run.settle();
    const sent = run.callsOf("MeterValues");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const value = (
      sent[0]!.payload as {
        meterValue: Array<{ sampledValue: Array<{ value: string }> }>;
      }
    ).meterValue[0]!.sampledValue[0]!.value;
    expect(Number(value)).toBeGreaterThanOrEqual(1000);
    expect(
      run.cp.engine.snapshot().behaviors["disconnect-on-charging"]
        .meterValuesAltered,
    ).toBeGreaterThanOrEqual(1);
  });

  test("the same seed gives the same frames", async () => {
    const a = await charging("seed-3");
    const b = await charging("seed-3");
    expect(a.effectHash()).toBe(b.effectHash());
  });
});
