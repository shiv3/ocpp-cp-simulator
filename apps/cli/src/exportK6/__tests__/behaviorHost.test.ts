// The k6 host of the behavior API, on a fake charge point and real (short)
// timers. The k6 side is exercised by the real-k6 run in docs/analyses/charger-engine.md.
import { describe, expect, it } from "vitest";
import { RngStreams } from "@ocpp-cp-sim/core/cp/shared/rng";
import {
  BehaviorHost,
  BehaviorStopped,
  BehaviorTimeout,
  unmetBy,
  type BehaviorCp,
  type CallHandler,
} from "@ocpp-cp-sim/k6-runtime/behaviorHost";
import { seededStream } from "@ocpp-cp-sim/k6-runtime/behaviorRandom";
import type { Behavior } from "@ocpp-cp-sim/k6-runtime/behaviorTypes";
import type { WireCall } from "@ocpp-cp-sim/k6-runtime/types";

const timers = {
  setTimeout: (fn: () => void, ms: number) =>
    setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
};

function fakeCp() {
  const calls: WireCall[] = [];
  const raws: string[] = [];
  let handler: CallHandler | null = null;
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
    getLocalStatus: () => "Available",
  };
  return { cp, calls, raws, handler: () => handler };
}

function host(behaviors: Behavior[], cp: BehaviorCp) {
  return new BehaviorHost({ cp, behaviors, timers, seed: "s" });
}

describe("BehaviorHost onCall", () => {
  it("claims a CALL of its action and answers with the response, then runs after", async () => {
    const f = fakeCp();
    const order: string[] = [];
    const h = host(
      [
        {
          api: 1,
          id: "b",
          onCall: {
            Reset: {
              mode: "replace",
              match: { type: "Hard" },
              handle: () => ({
                response: { status: "Accepted" },
                after: async () => {
                  order.push("after");
                },
              }),
            },
          },
        },
      ],
      f.cp,
    );
    h.start();
    expect(f.handler()?.("Reset", { type: "Soft" })).toBeNull();
    expect(f.handler()?.("Other", {})).toBeNull();
    const claimed = f.handler()?.("Reset", { type: "Hard" });
    expect(claimed).not.toBeNull();
    expect(await claimed?.answer).toEqual({
      kind: "result",
      payload: { status: "Accepted" },
    });
    order.push("sent");
    claimed?.sent();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["sent", "after"]);
  });

  it("answers a second CALL while the rule is busy with GenericError, and recovers", async () => {
    const f = fakeCp();
    let release: () => void = () => undefined;
    const h = host(
      [
        {
          api: 1,
          id: "b",
          onCall: {
            Reset: {
              mode: "replace",
              handle: () =>
                new Promise((resolve) => {
                  release = () => resolve({ response: {} });
                }),
            },
          },
        },
      ],
      f.cp,
    );
    h.start();
    const first = f.handler()?.("Reset", {});
    const second = f.handler()?.("Reset", {});
    expect(await second?.answer).toMatchObject({
      kind: "error",
      code: "GenericError",
    });
    await new Promise((r) => setTimeout(r, 1));
    release();
    expect(await first?.answer).toEqual({ kind: "result", payload: {} });
    const third = f.handler()?.("Reset", {});
    expect(third).not.toBeNull();
    release();
  });

  it("answers InternalError when the handler throws, and supports error and noResponse", async () => {
    const f = fakeCp();
    const h = host(
      [
        {
          api: 1,
          id: "b",
          onCall: {
            A: {
              mode: "replace",
              handle: () => {
                throw new Error("boom");
              },
            },
            B: {
              mode: "replace",
              handle: () => ({
                error: { code: "NotSupported", description: "x" },
              }),
            },
            C: { mode: "replace", handle: () => ({ noResponse: true }) },
          },
        },
      ],
      f.cp,
    );
    h.start();
    expect(await f.handler()?.("A", {})?.answer).toMatchObject({
      kind: "error",
      code: "InternalError",
    });
    expect(await f.handler()?.("B", {})?.answer).toEqual({
      kind: "error",
      code: "NotSupported",
      description: "x",
    });
    expect(await f.handler()?.("C", {})?.answer).toEqual({ kind: "none" });
  });
});

describe("BehaviorHost main and stop", () => {
  it("stop rejects pending waits so a looping main ends", async () => {
    const f = fakeCp();
    let ended = "";
    const h = host(
      [
        {
          api: 1,
          id: "loop",
          async main(ctx) {
            try {
              while (!ctx.stopping) await ctx.sleep(10_000);
            } catch (e) {
              ended = e instanceof BehaviorStopped ? "stopped" : "other";
              throw e;
            }
          },
        },
      ],
      f.cp,
    );
    h.start();
    await new Promise((r) => setTimeout(r, 5));
    const start = Date.now();
    expect(await h.stop(1000)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(500);
    expect(ended).toBe("stopped");
    expect(f.handler()).toBeNull();
  });

  it("gives up on a main that waits on something it does not own", async () => {
    const f = fakeCp();
    const h = host(
      [{ api: 1, id: "hang", main: () => new Promise<void>(() => undefined) }],
      f.cp,
    );
    h.start();
    const start = Date.now();
    expect(await h.stop(50)).toEqual(["hang"]);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("until resolves, times out, and is stopped", async () => {
    const f = fakeCp();
    const results: string[] = [];
    const h = host(
      [
        {
          api: 1,
          id: "u",
          async main(ctx) {
            results.push(
              String(await ctx.until(Promise.resolve(7), { ms: 100 })),
            );
            try {
              await ctx.until(new Promise<void>(() => undefined), { ms: 10 });
            } catch (e) {
              results.push(e instanceof BehaviorTimeout ? "timeout" : "?");
            }
            try {
              await ctx.until(new Promise<void>(() => undefined), {
                ms: 10_000,
              });
            } catch (e) {
              results.push(e instanceof BehaviorStopped ? "stopped" : "?");
            }
          },
        },
      ],
      f.cp,
    );
    h.start();
    await new Promise((r) => setTimeout(r, 60));
    await h.stop(500);
    expect(results).toEqual(["7", "timeout", "stopped"]);
  });
});

describe("BehaviorHost ctx", () => {
  it("send, notify, raw, state and charger go through the charge point", async () => {
    const f = fakeCp();
    const h = host(
      [
        {
          api: 1,
          id: "c",
          async main(ctx) {
            await ctx.send("DataTransfer", { vendorId: "v" });
            ctx.notify.firmwareStatus("Installed", { requestId: 9 });
            ctx.notify.logStatus("Uploaded", { requestId: 3 });
            ctx.raw("[2]");
            ctx.state.n = 1;
            ctx.state = { m: 2 };
            ctx.log("hi");
            expect(ctx.charger).toMatchObject({
              id: "CP-1",
              ocppVersion: "OCPP-1.6J",
              connectorIds: [1],
            });
            expect(() => ctx.plugIn(1)).toThrow(/not supported by the k6 host/);
            expect(() => ctx.connector(1)).toThrow(/ctx\.connector/);
            expect(ctx.state).toEqual({ m: 2 });
          },
        },
      ],
      f.cp,
    );
    h.start();
    await h.mainsDone();
    expect(f.calls).toEqual([
      { action: "DataTransfer", payload: { vendorId: "v" } },
      {
        action: "FirmwareStatusNotification",
        payload: { status: "Installed" },
      },
      {
        action: "LogStatusNotification",
        payload: { status: "Uploaded", requestId: 3 },
      },
    ]);
    expect(f.raws).toEqual(["[2]"]);
  });

  it("random draws what the simulator's stream draws for the same seed", () => {
    const core = new RngStreams("seed-1").stream("CP-9", "b/x");
    const k6 = seededStream("seed-1", "CP-9", "b/x");
    for (let i = 0; i < 5; i++) expect(k6.next()).toBe(core.next());
    const coreInt = new RngStreams("seed-1").stream("CP-9", "b/y");
    const k6Int = seededStream("seed-1", "CP-9", "b/y");
    for (let i = 0; i < 5; i++) {
      expect(k6Int.int(10, 20)).toBe(coreInt.int(10, 21));
    }
  });
});

describe("unmetBy", () => {
  it("lists capabilities and modes the host cannot meet", () => {
    expect(
      unmetBy({ api: 1, id: "ok", requires: ["ocpp1.6", "raw-frames"] }),
    ).toEqual([]);
    const problems = unmetBy({
      api: 1,
      id: "x",
      requires: ["physical", "virtual-time", "ocpp2.x"],
      onCall: { Reset: { mode: "extend", handle: () => ({ response: {} }) } },
    });
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain('"virtual-time"');
    expect(problems.join("\n")).toContain('mode "extend"');
  });

  it("host construction refuses what unmetBy lists", () => {
    const f = fakeCp();
    expect(() =>
      host([{ api: 1, id: "x", requires: ["physical"] }], f.cp),
    ).toThrow(/requires "physical"/);
  });
});
