import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargerEngine } from "../../cp/application/engine/ChargerEngine";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";
import { InboundCallGate } from "../../cp/infrastructure/transport/inbound/InboundCallGate";
import { BehaviorRegistry } from "../../cp/application/behavior/BehaviorRegistry";

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

describe("work outlives its stop", () => {
  test("E1 main that awaits only ctx.send stops after unload", async () => {
    let n = 0;
    let atUnload = -1;
    let unload: () => void = () => {};
    const b: Behavior = {
      api: 1,
      id: "loop",
      main: async (ctx) => {
        while (n < 20) {
          n++;
          await ctx.send("DataTransfer", { vendorId: "x" });
        }
      },
    };
    const run = await start({
      version: "1.6",
      seed: "x",
      responders: {
        DataTransfer: (_p, c) => {
          if (c.nth === 3) {
            unload();
            atUnload = n;
          }
          return { status: "Accepted" };
        },
      },
    });
    unload = () => run.cp.engine.unloadBehavior("loop");
    run.cp.loadBehavior(b);
    await run.settle();
    expect(atUnload).toBe(3);
    expect(n).toBeLessThanOrEqual(4);
  });
  test("E1b physical verbs and notify after a call scope was cut off by disconnect", async () => {
    const b: Behavior = {
      api: 1,
      id: "c",
      requires: ["physical"],
      onCall: {
        Reset: {
          mode: "replace",
          handle: () => ({
            response: { status: "Accepted" },
            after: async () => {
              await gate; // not a ctx wait, so the scope cannot cut it
              ctx0!.setConnectorStatus(1, "Preparing");
            },
          }),
        },
      },
    };
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let ctx0:
      | import("@ocpp-cp-simulator/contracts/behavior").BehaviorContext
      | undefined;
    const wrapped: Behavior = {
      ...b,
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_q, ctx) => {
            ctx0 = ctx;
            return (
              b.onCall!.Reset as never as {
                handle: (a: unknown, c: unknown) => never;
              }
            ).handle(_q, ctx);
          },
        },
      },
    };
    const run = await start({
      version: "1.6",
      behaviors: [wrapped],
      seed: "x",
    });
    await run.call("Reset", { type: "Soft" });
    await run.settle();
    run.cp.engine.unloadBehavior("c");
    open();
    await run.settle();
    // a cut-off context must not move the connector
    expect(run.cp.getConnector(1)!.status).not.toBe("Preparing");
  });

  test("E2 onResume is cut off by unload", async () => {
    let woke = false;
    const b: Behavior = {
      api: 1,
      id: "res",
      onResume: async (ctx) => {
        await ctx.sleep(1000);
        woke = true;
      },
    };
    const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
    (run.cp.engine as ChargerEngine).resume();
    await run.settle();
    run.cp.engine.unloadBehavior("res");
    await run.advance(2000);
    expect(woke).toBe(false);
  });

  test("E3 onResume is asked to stop by a reload (ctx.stopping)", async () => {
    let sawStopping = false;
    const mk = (): Behavior => ({
      api: 1,
      id: "res",
      onResume: async (ctx) => {
        await ctx.sleep(1000);
        sawStopping = ctx.stopping;
      },
    });
    const run = await start({ version: "1.6", behaviors: [mk()], seed: "x" });
    (run.cp.engine as ChargerEngine).resume();
    await run.settle();
    run.cp.engine.replaceBehavior(mk());
    await run.advance(2000);
    expect(sawStopping).toBe(true);
  });

  test("E4 a dormant behavior gets no onResume", async () => {
    let ran = false;
    const b: Behavior = {
      api: 1,
      id: "d",
      onResume: async () => {
        ran = true;
      },
    };
    const run = await start({ version: "1.6", seed: "x" });
    run.cp.loadBehavior(b, { dormant: true });
    (run.cp.engine as ChargerEngine).resume();
    await run.settle();
    expect(ran).toBe(false);
  });

  test("E5 reload then unload answers the exchange the old rule held", async () => {
    const mk = (): Behavior => ({
      api: 1,
      id: "b",
      onCall: {
        Reset: {
          mode: "replace",
          handle: async (_r, ctx) => {
            await ctx.sleep(5000);
            return { response: { status: "Accepted" } };
          },
        },
      },
    });
    const run = await start({ version: "1.6", behaviors: [mk()], seed: "x" });
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.engine.replaceBehavior(mk());
    run.cp.engine.unloadBehavior("b");
    await run.advance(10_000);
    const answer = run
      .frames()
      .find((f) => f.dir === "CP>" && f.id === id && f.kind !== "call");
    expect(answer).toBeDefined();
  });

  test("E5b control: unload without a reload answers it", async () => {
    const mk = (): Behavior => ({
      api: 1,
      id: "b",
      onCall: {
        Reset: {
          mode: "replace",
          handle: async (_r, ctx) => {
            await ctx.sleep(5000);
            return { response: { status: "Accepted" } };
          },
        },
      },
    });
    const run = await start({ version: "1.6", behaviors: [mk()], seed: "x" });
    const id = run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.engine.unloadBehavior("b");
    await run.advance(10_000);
    expect(
      run
        .frames()
        .find((f) => f.dir === "CP>" && f.id === id && f.kind !== "call"),
    ).toBeDefined();
  });

  test("E6 noResponse on a CALL abandoned by a disconnect does not run after", async () => {
    let afterRan = false;
    const b: Behavior = {
      api: 1,
      id: "n",
      onCall: {
        Reset: {
          mode: "replace",
          handle: async () => {
            await gate;
            return {
              noResponse: true,
              after: async () => {
                afterRan = true;
              },
            };
          },
        },
      },
    };
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
    run.callNoWait("Reset", { type: "Soft" });
    await run.settle();
    run.cp.disconnect();
    await run.settle();
    open();
    await run.settle();
    expect(afterRan).toBe(false);
  });
});

describe("after and undelivered answers", () => {
  test("E12 after does not run when the CALLRESULT died with the connection (network close)", async () => {
    let afterRan = false;
    const warns: string[] = [];
    const b: Behavior = {
      api: 1,
      id: "a",
      onCall: {
        Reset: {
          mode: "replace",
          handle: () => ({
            response: { status: "Accepted" },
            after: async () => {
              afterRan = true;
            },
          }),
        },
      },
    };
    const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
    const w = run.cp.logger.warn.bind(run.cp.logger);
    run.cp.logger.warn = ((m: string, t: never) => {
      warns.push(m);
      w(m, t);
    }) as never;
    run.cp.setNetworkSimConfig({
      enabled: true,
      seed: 1,
      rules: { l: { type: "latency", direction: "upstream", delayMs: 200 } },
    } as never);
    const id = run.callNoWait("Reset", { type: "Soft" });
    await new Promise((r) => setTimeout(r, 30));
    run.csms.dropConnection();
    await new Promise((r) => setTimeout(r, 400));
    await run.settle();
    expect(
      run
        .frames()
        .find((f) => f.dir === "CP>" && f.id === id && f.kind !== "call"),
    ).toBeUndefined();
    expect(afterRan).toBe(false);
  });
});

describe("dormant", () => {
  test("E7 useBehavior-style activation starts main (LoadBehaviorOptions: 'main does not start until a scenario selects')", async () => {
    let ran = false;
    const b: Behavior = {
      api: 1,
      id: "d",
      main: async () => {
        ran = true;
      },
    };
    const run = await start({ version: "1.6", seed: "x" });
    run.cp.loadBehavior(b, { dormant: true });
    run.cp.engine.activateBehavior("d", {
      kind: "scenario",
      scenarioId: "s",
      connectorId: 1,
      nodeId: "n",
    });
    await run.settle();
    expect(ran).toBe(true);
  });
});

describe("rule ranking", () => {
  test("E8 a reload keeps a rule's rank against another behavior", async () => {
    const mk = (id: string, s: string): Behavior => ({
      api: 1,
      id,
      onCall: {
        Reset: { mode: "replace", handle: () => ({ response: { status: s } }) },
      },
    });
    const run = await start({
      version: "1.6",
      behaviors: [mk("a", "Accepted"), mk("b", "Rejected")],
      seed: "x",
    });
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Accepted",
    });
    run.cp.engine.replaceBehavior(mk("a", "Accepted"));
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Accepted",
    });
  });

  const gateFor = (registry: BehaviorRegistry) =>
    new InboundCallGate({
      ports: {
        notifyReceived: () => {},
        policyFor: () => undefined,
        takeOverride: () => null,
      },
      registry,
      info: () => {},
      warn: () => {},
    });
  const exch = (action: string) => ({
    action,
    messageId: "m",
    state: "open",
    onClosed() {},
    reply() {},
    replyError() {},
    respond: async () => ({ delivered: true }),
    respondError: async () => ({ delivered: true }),
    suppress() {},
  });
  for (const [what, action, payload] of [
    [
      "RequestStartTransaction evseId",
      "RequestStartTransaction",
      { evseId: 2, idToken: {}, remoteStartId: 1 },
    ],
    [
      "ChangeAvailability evse{id:2,connectorId:1}",
      "ChangeAvailability",
      { evse: { id: 2, connectorId: 1 }, operationalStatus: "Inoperative" },
    ],
    [
      "ReserveNow evseId",
      "ReserveNow",
      { evseId: 2, id: 1, idToken: {}, expiryDateTime: "x" },
    ],
  ] as const)
    test(`E9 2.x ${what} ranks the rule of connector 2 first`, () => {
      const registry = new BehaviorRegistry({
        ocppVersion: () => "OCPP-2.0.1",
      });
      const took: number[] = [];
      for (const connectorId of [1, 2])
        registry.register({
          owner: {
            kind: "scenario",
            scenarioId: "s",
            connectorId,
            nodeId: "n",
          },
          action,
          connectorId,
          mode: "replace",
          take: () => {
            took.push(connectorId);
          },
        });
      gateFor(registry).admit(exch(action) as never, payload);
      expect(took).toEqual([2]);
    });
});

describe("action spelling", () => {
  test("E10 onCall keyed in the 2.x spelling answers on a 1.6 station ('in either OCPP version's spelling')", async () => {
    const b: Behavior = {
      api: 1,
      id: "s",
      onCall: {
        RequestStartTransaction: {
          mode: "replace",
          handle: () => ({ response: { status: "Rejected" } }),
        },
      },
    };
    const run = await start({ version: "1.6", behaviors: [b], seed: "x" });
    expect(
      (await run.call("RemoteStartTransaction", { idTag: "T", connectorId: 1 }))
        .payload,
    ).toEqual({ status: "Rejected" });
  });
});

describe("extend without a default", () => {
  const extend = (action: string): Behavior => ({
    api: 1,
    id: "e",
    onCall: {
      [action]: {
        mode: "extend",
        handle: (req, ctx) => ({ response: ctx.defaultBehavior(req) }),
      },
    },
  });
  for (const [v, action] of [
    ["1.6", "GetConfiguration"],
    ["1.6", "TriggerMessage"],
    ["2.0.1", "GetVariables"],
    ["2.0.1", "TriggerMessage"],
  ] as const)
    test(`E11 ${v} ${action}: extend is refused at load, there is no default to extend`, async () => {
      await expect(
        start({ version: v, behaviors: [extend(action)], seed: "x" }),
      ).rejects.toThrow(/no default behavior to extend/);
    });
  for (const [v, action, payload] of [
    ["2.0.1", "ChangeAvailability", { operationalStatus: "Operative" }],
    [
      "2.0.1",
      "GetLog",
      {
        logType: "DiagnosticsLog",
        requestId: 1,
        log: { remoteLocation: "http://127.0.0.1:1/x" },
      },
    ],
    ["1.6", "Reset", { type: "Soft" }],
  ] as const)
    test(`E11 ${v} ${action}: extend reaches the default it has`, async () => {
      const run = await start({
        version: v,
        behaviors: [extend(action)],
        seed: "x",
      });
      expect((await run.call(action, payload)).kind).toBe("result");
    });
});

describe("ids a behavior may not have", () => {
  for (const id of [
    "default.logs",
    "default.mine",
    "__proto__",
    "constructor",
    "toString",
  ])
    test(`${JSON.stringify(id)} is refused at load`, async () => {
      await expect(
        start({ version: "1.6", behaviors: [{ api: 1, id }], seed: "x" }),
      ).rejects.toThrow(/reserved|not allowed/);
    });
});
