import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

async function start(
  behaviors: Behavior[],
  version: "1.6" | "2.0.1" = "1.6",
  seed = "hooks",
): Promise<BehaviorRun> {
  const run = await runBehavior({ version, behaviors, seed });
  runs.push(run);
  return run;
}

const statusFrames = (run: BehaviorRun): string[] =>
  run
    .callsOf("StatusNotification")
    .map((f) => (f.payload as { status: string }).status);

describe("event hooks", () => {
  test("connectorStatus carries from and to, and ctx shows the new state", async () => {
    const seen: unknown[] = [];
    const run = await start([
      {
        api: 1,
        id: "watch",
        on: {
          connectorStatus: (e, ctx) => {
            seen.push({ ...e, now: ctx.connector(e.connectorId)?.status });
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    run.cp.updateConnectorStatus(1, "Available" as never);
    await run.settle();
    expect(seen).toEqual([
      { connectorId: 1, from: "Available", to: "Preparing", now: "Available" },
      { connectorId: 1, from: "Preparing", to: "Available", now: "Available" },
    ]);
  });

  test("a hook never runs inside the turn that caused the event", async () => {
    let inside = false;
    let ranInside = false;
    const run = await start([
      {
        api: 1,
        id: "watch",
        on: {
          connectorStatus: () => {
            ranInside = inside;
          },
        },
      },
    ]);
    inside = true;
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    inside = false;
    await run.settle();
    expect(ranInside).toBe(false);
  });

  test.each(["1.6", "2.0.1"] as const)(
    "transactionStarted and transactionStopped on %s",
    async (version) => {
      const seen: string[] = [];
      const run = await start(
        [
          {
            api: 1,
            id: "tx",
            requires: ["physical"],
            main: async (ctx) => {
              ctx.plugIn(1);
              await ctx.sleep(1_000);
              ctx.startCharging(1, "TAG-1");
              await ctx.sleep(5_000);
              ctx.stopCharging(1, "Local");
            },
            on: {
              transactionStarted: (e) => {
                seen.push(`started ${e.connectorId} ${e.idTag}`);
              },
              transactionStopped: (e) => {
                seen.push(`stopped ${e.connectorId} ${e.idTag}`);
              },
            },
          },
        ],
        version,
      );
      await run.advanceInSteps(8_000, 500);
      expect(seen).toEqual(["started 1 TAG-1", "stopped 1 TAG-1"]);
    },
  );

  test("connected and disconnected", async () => {
    const seen: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "link",
        on: {
          connected: () => {
            seen.push("connected");
          },
          disconnected: (e) => {
            seen.push(`disconnected ${typeof e.code}`);
          },
        },
      },
    ]);
    run.cp.disconnect();
    await run.settle();
    expect(seen).toEqual(["disconnected number"]);
    run.cp.connect();
    await run.settle();
    expect(seen).toEqual(["disconnected number", "connected"]);
  });

  test.each(["1.6", "2.0.1"] as const)(
    "callResult reports the answer of an automatic CALL on %s",
    async (version) => {
      const seen: Array<{ action: string; outcome: string; payload: unknown }> =
        [];
      const run = await start(
        [
          {
            api: 1,
            id: "results",
            on: {
              callResult: (e) => {
                seen.push({
                  action: e.action,
                  outcome: e.outcome,
                  payload: e.payload,
                });
              },
            },
          },
        ],
        version,
      );
      run.cp.updateConnectorStatus(1, "Preparing" as never);
      await run.settle();
      expect(seen.map((s) => s.action)).toEqual(["StatusNotification"]);
      expect(seen[0]!.outcome).toBe("result");
    },
  );

  test("callResult reports a CALLERROR", async () => {
    const seen: Array<{ outcome: string; payload: unknown }> = [];
    const run = await runBehavior({
      version: "1.6",
      responders: {
        StatusNotification: () => ({
          error: { code: "InternalError", description: "boom" },
        }),
      },
      behaviors: [
        {
          api: 1,
          id: "results",
          on: {
            callResult: (e) => {
              seen.push({ outcome: e.outcome, payload: e.payload });
            },
          },
        },
      ],
    });
    runs.push(run);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(seen).toEqual([
      {
        outcome: "error",
        payload: expect.objectContaining({ errorCode: "InternalError" }),
      },
    ]);
  });

  test("callReceived sees the CSMS CALL and cannot change the answer", async () => {
    const seen: string[] = [];
    const withHook = await start([
      {
        api: 1,
        id: "obs",
        on: {
          callReceived: (e) => {
            seen.push(e.action);
            return undefined;
          },
        },
      },
    ]);
    const answer = await withHook.call("Reset", { type: "Soft" });
    expect(seen).toEqual(["Reset"]);
    const plain = await start([]);
    const same = await plain.call("Reset", { type: "Soft" });
    expect(answer.payload).toEqual(same.payload);
  });

  test("several behaviors receive the event in load order", async () => {
    const order: string[] = [];
    const mk = (id: string): Behavior => ({
      api: 1,
      id,
      on: {
        connectorStatus: () => {
          order.push(id);
        },
      },
    });
    const run = await start([mk("a"), mk("b"), mk("c")]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("a throwing hook is logged and the charger carries on", async () => {
    const order: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "bad",
        on: {
          connectorStatus: () => {
            throw new Error("hook bug");
          },
        },
      },
      {
        api: 1,
        id: "good",
        on: {
          connectorStatus: () => {
            order.push("good");
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(order).toEqual(["good"]);
    expect(statusFrames(run)).toEqual(["Preparing"]);
  });

  test("an async hook is not awaited, and a rejection is logged", async () => {
    const order: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "slow",
        on: {
          connectorStatus: () => new Promise<void>(() => undefined),
        },
      },
      {
        api: 1,
        id: "rejects",
        on: {
          connectorStatus: async () => {
            throw new Error("later");
          },
        },
      },
      {
        api: 1,
        id: "next",
        on: {
          connectorStatus: () => {
            order.push("next");
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(order).toEqual(["next"]);
  });

  test("re-entrancy: a hook that writes runs after the event, and its own event after the hook", async () => {
    const log: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "react",
        requires: ["physical"],
        on: {
          connectorStatus: (e, ctx) => {
            log.push(`begin ${e.to}`);
            if (e.to === "Preparing") {
              ctx.setConnectorStatus(1, "Available");
              log.push("wrote Available");
            }
            log.push(`end ${e.to}`);
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    log.push("caller done");
    await run.settle();
    // The hook starts after the caller's turn; the status event its write
    // caused is delivered after the hook returned, never nested in it.
    expect(log).toEqual([
      "caller done",
      "begin Preparing",
      "wrote Available",
      "end Preparing",
      "begin Available",
      "end Available",
    ]);
    // Wire order: the event's own traffic first, then the hook's.
    expect(statusFrames(run)).toEqual(["Preparing", "Available"]);
  });

  test("a hook that sends goes out after the traffic of the event", async () => {
    const run = await start([
      {
        api: 1,
        id: "send",
        on: {
          connectorStatus: (_e, ctx) => {
            void ctx.send("DataTransfer", { vendorId: "x", messageId: "seen" });
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    const kinds = run
      .frames()
      .filter((f) => f.dir === "CP>" && f.kind === "call")
      .map((f) => f.action);
    expect(kinds).toEqual(["StatusNotification", "DataTransfer"]);
  });

  test("same seed, same effects with hooks on a VirtualClock", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await start([
        {
          api: 1,
          id: "det",
          requires: ["physical"],
          main: async (ctx) => {
            ctx.plugIn(1);
            await ctx.sleep(ctx.random("d").int(100, 900));
            ctx.startCharging(1, "T");
          },
          on: {
            transactionStarted: async (_e, ctx) => {
              await ctx.sleep(10);
              ctx.log("started");
              void ctx.send("DataTransfer", { vendorId: "det" });
            },
            connectorStatus: (_e, ctx) => {
              ctx.state.n = Number(ctx.state.n ?? 0) + 1;
            },
          },
        },
      ]);
      await run.advanceInSteps(3_000, 250);
      hashes.push(run.effectHash());
    }
    expect(hashes[0]).toBe(hashes[1]!);
  });

  test("a hook of an unloaded behavior no longer runs", async () => {
    const order: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "gone",
        on: {
          connectorStatus: () => {
            order.push("gone");
          },
        },
      },
    ]);
    run.cp.unloadBehavior("gone");
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(order).toEqual([]);
  });
});

describe("ctx.connector().power (#327)", () => {
  test("is a read-only snapshot of the operating point", async () => {
    const seen: unknown[] = [];
    const run = await start([
      {
        api: 1,
        id: "watch-power",
        on: {
          connectorStatus: (e, ctx) => {
            seen.push(ctx.connector(e.connectorId)?.power);
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    // Not charging: nothing accepted or offered; the rest is the connector's
    // own operating point.
    const connector = run.cp.getConnector(1)!;
    const point = connector.operatingPoint();
    expect(seen).toEqual([
      { acceptedW: 0, offeredW: 0, soc: point.soc, limitedBy: point.limitedBy },
    ]);
  });
});
