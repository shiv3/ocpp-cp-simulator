import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
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

async function charge(run: BehaviorRun) {
  run.cp.updateConnectorStatus(1, "Preparing" as never);
  await run.settle();
  await run.cp.startTransaction("TAG", 1);
  await run.advanceInSteps(1000, 100);
}

describe("a beforeSend rewrite must not cut the CALL from its answer (1.6)", () => {
  for (const [name, fn] of [
    ["control (no rewrite)", (p: Record<string, unknown>) => p],
    ["idTag", (p: Record<string, unknown>) => ({ ...p, idTag: "REWRITTEN" })],
    [
      "timestamp",
      (p: Record<string, unknown>) => ({
        ...p,
        timestamp: "2031-01-01T00:00:00.000Z",
      }),
    ],
  ] as const)
    test(`R1 StartTransaction rewrite of ${name}: the CSMS transactionId is adopted`, async () => {
      const b: Behavior = {
        api: 1,
        id: "r",
        beforeSend: { StartTransaction: fn },
      };
      const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
      await charge(run);
      const answered = run
        .frames()
        .find(
          (f) =>
            f.dir === "CSMS>" &&
            f.kind === "result" &&
            (f.payload as { transactionId?: number }).transactionId,
        );
      expect(answered).toBeDefined();
      expect(run.cp.getConnector(1)!.transaction!.id).toBe(
        (answered!.payload as { transactionId: number }).transactionId,
      );
    });

  for (const rewrite of [false, true])
    test(`R2 Authorize rewrite=${rewrite}: the waiting start is told the CSMS verdict (false is the control)`, async () => {
      const b: Behavior = {
        api: 1,
        id: "r",
        beforeSend: {
          Authorize: (p) =>
            rewrite ? { ...p, idTag: "REWRITTEN" } : undefined,
        },
      };
      const run = await start({
        version: "1.6",
        behaviors: [b],
        seed: "x",
        responders: { Authorize: () => ({ idTagInfo: { status: "Blocked" } }) },
      });
      run.cp.updateConnectorStatus(1, "Preparing" as never);
      await run.settle();
      const started = run.cp.startTransaction("TAG", 1);
      await run.advanceInSteps(60_000, 1000);
      await started;
      // CSMS said Blocked; no transaction may start
      expect(run.callsOf("Authorize")).toHaveLength(1);
      expect(run.callsOf("StartTransaction")).toHaveLength(0);
    });
});
