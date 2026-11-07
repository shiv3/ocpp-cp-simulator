import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";
import { definition, startScenario } from "../behavior/runScenario";
import { Connector } from "../../cp/domain/connector/Connector";

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

describe("scenario", () => {
  test("M1 useBehavior inside an internal loop does not fail the run on its second pass", async () => {
    const run = await start({ version: "1.6" });
    run.cp.loadBehavior(
      {
        api: 1,
        id: "rr",
        onCall: {
          Reset: {
            mode: "replace",
            handle: () => ({ response: { status: "Rejected" } }),
          },
        },
      },
      { dormant: true },
    );
    const def = definition([
      { id: "use", type: "useBehavior", data: { behaviorId: "rr" } },
      { id: "d1", type: "delay", data: { delaySeconds: 1 } },
      { id: "d2", type: "delay", data: { delaySeconds: 1 } },
    ]) as {
      nodes: { id: string }[];
      edges: { id: string; source: string; target: string }[];
    };
    // close the loop: d2 -> use, drop d2 -> end
    def.edges = def.edges.filter((e) => e.source !== "d2");
    def.edges.push({ id: "back", source: "d2", target: "use" });
    const errors: string[] = [];
    const w = run.cp.logger.error.bind(run.cp.logger);
    run.cp.logger.error = ((m: string, t: never) => {
      errors.push(m);
      w(m, t);
    }) as never;
    const sc = startScenario(run, def as never);
    await run.settle();
    await run.advanceInSteps(5000, 500);
    const ctx = sc.executor.getContext?.();
    console.log("M1", ctx?.state, ctx?.error ?? "", errors.slice(0, 3));
    expect(ctx?.state).not.toBe("failed");
    expect(String(ctx?.error ?? "")).not.toMatch(/already registered/);
    sc.executor.stop?.();
  });
});

describe("transaction view", () => {
  test("M2 a view held past its transaction does not write the next transaction", () => {
    const c = new Connector(1, {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    const tx = (tag: string) => ({
      id: 0,
      connectorId: 1,
      tagId: tag,
      meterStart: 0,
      meterStop: null,
      startTime: new Date(0),
      stopTime: null,
      meterSent: false,
    });
    c.beginTransaction(tx("OLD") as never);
    const held = c.transaction!;
    c.stopTransaction();
    c.beginTransaction(tx("NEW") as never);
    held.meterStop = 42;
    expect(c.transaction!.meterStop).toBeNull();
  });
});

describe("exchange", () => {
  test("M5 a response that cannot be stringified still gets an answer (behavior, skipValidation)", async () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const b: Behavior = {
      api: 1,
      id: "c",
      onCall: {
        Reset: {
          mode: "replace",
          handle: () => ({ response: cyc, skipValidation: true }),
        },
      },
    };
    const run = await start({ version: "2.0.1", behaviors: [b] });
    const f = await run.call("Reset", { type: "Immediate" });
    expect(f.kind).toBe("error");
  });
  for (const v of ["1.6", "2.0.1"] as const)
    test(`M6 ${v} CALL named like an Object.prototype member gets NotImplemented`, async () => {
      const run = await start({ version: v });
      for (const action of [
        "constructor",
        "__proto__",
        "toString",
        "hasOwnProperty",
      ]) {
        const f = await run.call(action, {});
        expect(f.kind).toBe("error");
        expect(
          (f.payload as { errorCode?: string }).errorCode ??
            JSON.stringify(f.payload),
        ).toMatch(/NotImplemented|NotSupported/);
      }
    });
  for (const v of ["1.6", "2.0.1"] as const)
    test(`M7 ${v} null payload reaches a matching rule without crashing the station`, async () => {
      const b: Behavior = {
        api: 1,
        id: "m",
        onCall: {
          Reset: {
            mode: "replace",
            match: { type: "Soft" },
            handle: () => ({ response: { status: "Rejected" } }),
          },
        },
      };
      const run = await start({ version: v, behaviors: [b] });
      const f = await run.call("Reset", null);
      expect(["error", "result"]).toContain(f.kind);
    });
  test("M8 2.x sync replace handler answers in the same turn", async () => {
    const order: string[] = [];
    const b: Behavior = {
      api: 1,
      id: "s",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_r, ctx) => {
            void ctx.send("Heartbeat", {});
            return { response: { status: "Accepted" } };
          },
        },
      },
    };
    const run = await start({ version: "2.0.1", behaviors: [b] });
    const id = run.callNoWait("Reset", { type: "Immediate" });
    await run.settle();
    for (const f of run.frames())
      if (f.dir === "CP>" && (f.id === id || f.action === "Heartbeat"))
        order.push(f.kind);
    console.log("M8", order);
    expect(order.length).toBe(2);
  });
});
