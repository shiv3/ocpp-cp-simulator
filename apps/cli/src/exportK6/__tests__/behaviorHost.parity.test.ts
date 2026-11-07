// vitest: the k6 modules are stubbed like behaviorRun.test.ts does.
import { describe, expect, it } from "vitest";
import {
  BehaviorHost,
  type BehaviorCp,
  type CallHandler,
} from "@ocpp-cp-sim/k6-runtime/behaviorHost";
import type { Behavior } from "@ocpp-cp-sim/k6-runtime/behaviorTypes";
import type { CallObserver, WireCall } from "@ocpp-cp-sim/k6-runtime/types";
import { unsupportedCtxUses } from "../runExportK6Behavior";

const timers = {
  setTimeout: (fn: () => void, ms: number) =>
    setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
};
function fakeCp() {
  const calls: WireCall[] = [];
  const raws: string[] = [];
  let handler: CallHandler | null = null;
  let observer: CallObserver | null = null;
  const cp: BehaviorCp = {
    cpId: "CP-1",
    connectorId: 1,
    call(c) {
      calls.push(c);
      return Promise.resolve({ ok: true });
    },
    sendRaw: (f) => void raws.push(f),
    setCallHandler: (h) => {
      handler = h;
    },
    setObserver: (o) => {
      observer = o;
    },
    getLocalStatus: () => "Available",
  };
  return { cp, calls, raws, handler: () => handler, observer: () => observer };
}
const host = (
  behaviors: Behavior[],
  cp: BehaviorCp,
  log?: (m: string) => void,
) =>
  new BehaviorHost({
    cp,
    behaviors,
    timers,
    seed: "s",
    ...(log ? { log } : {}),
  });

describe("k6 host against the core engine's semantics", () => {
  it("C1 ctx.random(name) continues the stream on every call", async () => {
    const f = fakeCp();
    const got: number[] = [];
    host(
      [
        {
          api: 1,
          id: "b",
          main: async (ctx) => {
            for (let i = 0; i < 5; i++)
              got.push(ctx.random("jitter").int(0, 1_000_000));
          },
        },
      ],
      f.cp,
    ).start();
    await new Promise((r) => setTimeout(r, 5));
    expect(new Set(got).size).toBeGreaterThan(1);
  });

  it("C2 a handler that returns nothing gets a CALLERROR and frees the rule", async () => {
    const f = fakeCp();
    const h = host(
      [
        {
          api: 1,
          id: "b",
          onCall: {
            Reset: {
              mode: "replace",
              handle: (async () => undefined) as never,
            },
          },
        },
      ],
      f.cp,
    );
    h.start();
    const claimed = f.handler()!("Reset", {})!;
    const answer = await Promise.race([
      claimed.answer.catch((e: unknown) => `REJECTED: ${String(e)}`),
      new Promise((r) => setTimeout(() => r("NO ANSWER"), 50)),
    ]);
    expect(answer).toMatchObject({ kind: "error", code: "InternalError" });
    // The rule is free again, not stuck busy for the rest of the iteration.
    const second = f.handler()!("Reset", {})!;
    const again = await second.answer.catch(() => ({ kind: "rejected" }));
    expect((again as { description?: string }).description ?? "").not.toMatch(
      /busy/,
    );
  });

  it("C3 handle(...) keeps `this` as the rule's own object", async () => {
    const f = fakeCp();
    const h = host(
      [
        {
          api: 1,
          id: "b",
          onCall: {
            Reset: {
              mode: "replace",
              status: "Rejected",
              handle(this: { status: string }) {
                return { response: { status: this.status } };
              },
            } as never,
          },
        },
      ],
      f.cp,
    );
    h.start();
    expect(await f.handler()!("Reset", {})!.answer).toEqual({
      kind: "result",
      payload: { status: "Rejected" },
    });
  });

  it("C4 ctx.raw without requires raw-frames throws as on the simulator", async () => {
    const f = fakeCp();
    let thrown: unknown = null;
    host(
      [
        {
          api: 1,
          id: "b",
          main: async (ctx) => {
            try {
              ctx.raw('[2,"x"]');
            } catch (e) {
              thrown = e;
            }
          },
        },
      ],
      f.cp,
    ).start();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.raws).toEqual([]);
    expect(String(thrown)).toMatch(/raw-frames/);
  });

  it("C5 ctx.raw on a closed socket does not throw into the behavior", async () => {
    const f = fakeCp();
    f.cp.sendRaw = () => {
      throw new Error("connection closed");
    };
    let thrown: unknown = null;
    host(
      [
        {
          api: 1,
          id: "b",
          requires: ["raw-frames"],
          main: async (ctx) => {
            try {
              ctx.raw("x");
            } catch (e) {
              thrown = e;
            }
          },
        },
      ],
      f.cp,
    ).start();
    await new Promise((r) => setTimeout(r, 5));
    expect(thrown).toBeNull();
  });

  it("C6 two bundles with one id are refused, not merged into one ctx", () => {
    const f = fakeCp();
    expect(() =>
      host(
        [
          { api: 1, id: "dup" },
          { api: 1, id: "dup" },
        ],
        f.cp,
      ),
    ).toThrow();
  });
});

describe("stopping", () => {
  it("S2 a ctx.send waiting on a slow CSMS is cut at stop, so the main settles in time", async () => {
    const f = fakeCp();
    f.cp.call = () => new Promise(() => undefined); // the CSMS never answers
    let reached = false;
    const h = host(
      [
        {
          api: 1,
          id: "b",
          main: async (ctx) => {
            try {
              await ctx.send("DataTransfer", { vendorId: "x" });
            } finally {
              reached = true;
            }
          },
        },
      ],
      f.cp,
    );
    h.start();
    await new Promise((r) => setTimeout(r, 5));
    const left = await h.stop(200);
    expect(left).toEqual([]);
    expect(reached).toBe(true);
  });
});

describe("export checks", () => {
  it("C8 an array binding named connector is not a ctx use", () => {
    expect(unsupportedCtxUses("const [connector, status] = pair;")).toEqual([]);
  });
});
