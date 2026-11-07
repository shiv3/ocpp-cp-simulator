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
async function reconnect(run: BehaviorRun) {
  run.cp.connect();
  await run.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 5000 });
  await run.settle();
  await run.advanceInSteps(2000, 200);
}

describe("beforeSend and offline replay (1.6)", () => {
  test("a rewrite is applied once to a StopTransaction replayed from the offline queue", async () => {
    let seen = 0;
    const b: Behavior = {
      api: 1,
      id: "plus",
      beforeSend: {
        StopTransaction: (p) => {
          seen++;
          return { ...p, meterStop: (p.meterStop as number) + 1000 };
        },
      },
    };
    const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
    await charge(run);
    const c = run.cp.getConnector(1)!;
    run.cp.disconnect();
    await run.settle();
    run.cp.stopTransaction(c);
    await run.settle();
    await reconnect(run);
    const stop = run.callsOf("StopTransaction");
    expect(stop).toHaveLength(1);
    // one CALL, one interception
    expect(seen).toBe(1);
    expect((stop[0].payload as { meterStop: number }).meterStop).toBe(
      c.meterValue + 1000,
    );
  });
});

describe("beforeSend and resends", () => {
  test("1.6: a resend after CALLERROR is intercepted again (doc: 'A resend (1.6 transaction retries) is intercepted again as the new CALL it is')", async () => {
    let seen = 0;
    const b: Behavior = {
      api: 1,
      id: "count",
      beforeSend: {
        StopTransaction: () => {
          seen++;
          return undefined;
        },
      },
    };
    const run = await start({
      version: "1.6",
      behaviors: [b],
      seed: "x",
      responders: {
        StopTransaction: (_p, c) =>
          c.nth === 1
            ? { error: { code: "InternalError", description: "x" } }
            : { idTagInfo: { status: "Accepted" } },
      },
      beforeConnect: (cp) => {
        cp.configuration.applyChange("TransactionMessageRetryInterval", "0");
      },
    });
    await charge(run);
    run.cp.stopTransaction(run.cp.getConnector(1)!);
    await run.settle();
    await new Promise((r) => setTimeout(r, 30));
    await run.settle();
    expect(run.callsOf("StopTransaction").length).toBe(2);
    expect(seen).toBe(2);
  });
});

describe("2.x: a dropped TransactionEvent during replay", () => {
  for (const drop of [false, true])
    test(`does not stall later TransactionEvents (drop=${drop}; drop=false is the control)`, async () => {
      const b: Behavior = {
        api: 1,
        id: "dropstop",
        beforeSend: {
          StopTransaction: () => (drop ? { drop: true } : undefined),
        },
      };
      const run = await start({ version: "2.0.1", behaviors: [b], seed: "x" });
      const warns: string[] = [];
      const w = run.cp.logger.warn.bind(run.cp.logger);
      run.cp.logger.warn = ((m: string, t: never) => {
        warns.push(m);
        w(m, t);
      }) as never;
      await charge(run);
      const c = run.cp.getConnector(1)!;
      run.cp.disconnect();
      await run.settle();
      run.cp.stopTransaction(c);
      await run.settle();
      await reconnect(run);
      // next session on the same station
      run.cp.updateConnectorStatus(1, "Available" as never);
      run.cp.updateConnectorStatus(1, "Preparing" as never);
      await run.settle();
      const before = run.callsOf("TransactionEvent").length;
      await run.cp.startTransaction("TAG2", 1);
      await run.advanceInSteps(1000, 100);
      const after = run.callsOf("TransactionEvent").slice(before);
      expect(
        after.some(
          (f) => (f.payload as { eventType: string }).eventType === "Started",
        ),
      ).toBe(true);
    });
});
