import { afterEach, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";

/**
 * #565: a StopTransaction.req that waited in the serial queue behind a
 * StartTransaction.req and was then held behind its resend has been through
 * beforeSend once; leaving the hold must not run it again. One transmission,
 * one interception (docs/concepts/charger-engine.md).
 */

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

test("a held StopTransaction.req is intercepted once, and still takes the conf id", async () => {
  let seen = 0;
  const behavior: Behavior = {
    api: 1,
    id: "count-stop",
    beforeSend: {
      StopTransaction: () => {
        seen += 1;
        return undefined;
      },
    },
  };
  let starts = 0;
  const run = await runBehavior({
    version: "1.6",
    behaviors: [behavior],
    seed: "held-before-send",
    responders: {
      StartTransaction: () =>
        ++starts === 1
          ? { error: { code: "InternalError", description: "boom" } }
          : { transactionId: 42, idTagInfo: { status: "Accepted" } },
    },
  });
  runs.push(run);
  run.cp.updateConnectorStatus(1, "Preparing" as never);
  await run.settle();
  await run.cp.startTransaction("TAG", 1);
  // The CALLERROR has moved the stop (queued behind the start) into the hold.
  run.cp.stopTransaction(1, "Local");
  await run.advanceInSteps(120_000, 5_000);

  const stops = run.callsOf("StopTransaction");
  expect(stops).toHaveLength(1);
  expect((stops[0]!.payload as { transactionId: number }).transactionId).toBe(
    42,
  );
  expect(seen).toBe(1);
});

test("a StopTransaction.req still in the serial queue when the link closes is salvaged with the id a late conf assigned (#565)", async () => {
  const run = await runBehavior({
    version: "1.6",
    seed: "salvage-start-outcome",
    responders: {
      StartTransaction: () => "silent",
      Heartbeat: () => "silent",
    },
  });
  runs.push(run);
  run.cp.updateConnectorStatus(1, "Preparing" as never);
  await run.settle();
  void run.cp.startTransaction("TAG", 1);
  await run.settle();
  const startId = run.callsOf("StartTransaction")[0]!.id;
  // The start times out (1.6 does not resend a timeout); a Heartbeat takes
  // the slot and the stop queues behind it, still carrying the 0 placeholder.
  await run.advanceInSteps(31_000, 1_000);
  run.cp.sendHeartbeat();
  await run.settle();
  run.cp.stopTransaction(1, "Local");
  await run.settle();
  expect(run.callsOf("StopTransaction")).toHaveLength(0);

  // The conf arrives late, then the link drops.
  const result = { transactionId: 42, idTagInfo: { status: "Accepted" } };
  (
    run.csms as unknown as {
      sendRaw(frame: unknown, wire: unknown[]): void;
    }
  ).sendRaw({ dir: "CSMS>", kind: "result", id: startId, payload: result }, [
    3,
    startId,
    result,
  ]);
  await run.settle();
  run.csms.dropConnection();
  await run.settle();

  const queue = (
    run.cp as unknown as {
      _messageHandler: {
        _pendingQueue: {
          all(): Array<{ action: string; payload: { transactionId: number } }>;
        };
      };
    }
  )._messageHandler._pendingQueue.all();
  const stop = queue.find((m) => m.action === "StopTransaction");
  expect(stop?.payload.transactionId).toBe(42);
});
