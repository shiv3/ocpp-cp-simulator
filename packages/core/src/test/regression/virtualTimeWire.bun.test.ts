import { afterEach, expect, test } from "bun:test";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";
let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});
for (const v of ["1.6", "2.0.1"] as const)
  test(`V1 ${v} wire timestamps on a VirtualClock come from that clock`, async () => {
    const run = await runBehavior({ version: v, seed: "x" });
    runs.push(run);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    await run.cp.startTransaction("TAG", 1);
    await run.advanceInSteps(1000, 100);
    run.cp.sendMeterValue?.(1);
    await run.settle();
    const virtual = run.clock.now();
    const frames =
      v === "1.6"
        ? run.callsOf("MeterValues")
        : run.callsOf("TransactionEvent");
    const stamps = frames.flatMap((f) => {
      const p = f.payload as { meterValue?: { timestamp: string }[] };
      return (p.meterValue ?? []).map((m) => Date.parse(m.timestamp));
    });
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) expect(Math.abs(s - virtual)).toBeLessThan(60_000);
  });
