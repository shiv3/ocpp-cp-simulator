import { afterEach, describe, expect, test } from "bun:test";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";

const runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose();
});

interface WirePayload {
  meterValue: Array<{ timestamp: string }>;
  transactionInfo: { transactionId: string };
}
const payloadOf = (f: { payload?: unknown }) => f.payload as WirePayload;

describe("VirtualClock reaches the wire", () => {
  test("1.6 MeterValues timestamp is the charge point's clock (B9)", async () => {
    const run = await runBehavior({ version: "1.6", seed: "x" });
    runs.push(run);
    await run.cp.startTransaction("TAG", 1);
    await run.settle();
    await run.advance(1000);
    run.cp.sendMeterValue(1);
    await run.settle();
    const mv = run.callsOf("MeterValues").at(-1)!;
    const ts = new Date(payloadOf(mv).meterValue[0].timestamp).getTime();
    expect(ts).toBe(run.clock.now());
  });

  test("2.0.1: same seed, same transactionId and message ids (B10)", async () => {
    const once = async () => {
      const run = await runBehavior({ version: "2.0.1", seed: "same" });
      runs.push(run);
      await run.cp.startTransaction("TAG", 1);
      await run.settle();
      await run.advance(1000);
      const tx = run.callsOf("TransactionEvent")[0]!;
      return {
        transactionId: payloadOf(tx).transactionInfo.transactionId,
        messageId: tx.id,
      };
    };
    expect(await once()).toEqual(await once());
  });

  test("a CSMS that never answers: the 30 s CALL timeout runs on the station's clock (B11)", async () => {
    const run = await runBehavior({
      version: "1.6",
      responders: {
        DataTransfer: () => "silent",
      },
    });
    runs.push(run);
    const seen: string[] = [];
    void run.cp
      .sendOcppCall({ action: "DataTransfer", payload: { vendorId: "v" } })
      .then(
        (o) => seen.push(`settled:${o.kind}`),
        (e: Error) => seen.push(`rejected:${e.name}`),
      );
    await run.settle();
    await run.advance(120_000);
    expect(seen.length).toBe(1);
  });
});
