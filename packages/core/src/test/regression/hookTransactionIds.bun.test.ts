// Hook and ctx payloads of transactions (new in the branch; nothing to compare
// with on the base commit). Each test fails on 30b57145.
import { expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior } from "../behavior/runBehavior";

const watcher = (on: Behavior["on"]): Behavior => ({ api: 1, id: "watch", on });
type Tx = {
  eventType: string;
  transactionInfo: { transactionId: string; stoppedReason?: string };
};
const txEvents = (run: Awaited<ReturnType<typeof runBehavior>>) =>
  run.callsOf("TransactionEvent").map((f) => f.payload as Tx);

test("2.x transactionStarted hook carries the UUID of the Started event (doc: hook table)", async () => {
  const seen: unknown[] = [];
  const run = await runBehavior({
    version: "2.0.1",
    behaviors: [
      watcher({ transactionStarted: (e) => void seen.push(e.transactionId) }),
    ],
  });
  try {
    await run.cp.startTransaction("TAG", 1);
    await run.settle();
    const started = txEvents(run).find((p) => p.eventType === "Started");
    expect(seen).toEqual([started!.transactionInfo.transactionId]);
  } finally {
    await run.dispose();
  }
});

test("2.x ctx.connector(id).transactionId names the running transaction", async () => {
  let ctxRef: {
    connector(id: number): { transactionId: unknown } | undefined;
  } | null = null;
  const run = await runBehavior({
    version: "2.0.1",
    behaviors: [
      { api: 1, id: "grab", main: async (ctx) => void (ctxRef = ctx as never) },
    ],
  });
  try {
    await run.settle();
    await run.cp.startTransaction("TAG", 1);
    await run.settle();
    const started = txEvents(run).find((p) => p.eventType === "Started");
    expect(ctxRef!.connector(1)!.transactionId).toBe(
      started!.transactionInfo.transactionId,
    );
  } finally {
    await run.dispose();
  }
});

test("2.x transactionStopped reason is the reason on the wire", async () => {
  const seen: unknown[] = [];
  const run = await runBehavior({
    version: "2.0.1",
    behaviors: [
      watcher({ transactionStopped: (e) => void seen.push(e.reason) }),
    ],
  });
  try {
    await run.cp.startTransaction("TAG", 1);
    await run.settle();
    run.cp.stopTransaction(1, "Other", { stoppedReason: "SOCLimitReached" });
    await run.settle();
    const ended = txEvents(run).find((p) => p.eventType === "Ended");
    expect(ended!.transactionInfo.stoppedReason).toBe("SOCLimitReached");
    expect(seen).toEqual(["SOCLimitReached"]);
  } finally {
    await run.dispose();
  }
});

test("transactionStarted fires for a start over a closed transaction still attached", async () => {
  const seen: unknown[] = [];
  const run = await runBehavior({
    version: "1.6",
    behaviors: [
      watcher({ transactionStarted: (e) => void seen.push(e.idTag) }),
    ],
  });
  try {
    await run.cp.startTransaction("A", 1);
    await run.settle();
    run.cp.cleanTransaction(1);
    await run.settle();
    await run.cp.startTransaction("B", 1);
    await run.settle();
    expect(run.callsOf("StartTransaction")).toHaveLength(2);
    expect(seen).toEqual(["A", "B"]);
  } finally {
    await run.dispose();
  }
});
