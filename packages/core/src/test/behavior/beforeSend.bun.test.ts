import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

async function start(
  behaviors: Behavior[],
  version: "1.6" | "2.0.1" = "1.6",
): Promise<BehaviorRun> {
  const run = await runBehavior({ version, behaviors, seed: "before-send" });
  runs.push(run);
  return run;
}

const driver: Behavior = {
  api: 1,
  id: "driver",
  requires: ["physical"],
  main: async (ctx) => {
    ctx.plugIn(1);
    await ctx.sleep(500);
    ctx.startCharging(1, "TAG");
  },
};

describe("beforeSend", () => {
  test("rewrites an automatic CALL (Heartbeat is carried by a changed DataTransfer-free payload)", async () => {
    const run = await start([
      {
        api: 1,
        id: "rewrite",
        beforeSend: {
          StatusNotification: (payload) => ({
            ...payload,
            info: "rewritten",
          }),
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      status: "Preparing",
      info: "rewritten",
    });
  });

  test("drops an automatic Heartbeat: nothing on the wire, the charger carries on", async () => {
    const run = await start([
      {
        api: 1,
        id: "no-heartbeat",
        beforeSend: { Heartbeat: () => ({ drop: true }) },
      },
    ]);
    await run.call("ChangeConfiguration", {
      key: "HeartbeatInterval",
      value: "20",
    });
    let attempts = 0;
    run.cp.logger.warn = ((message: string) => {
      if (/Dropping Heartbeat/.test(message)) attempts++;
    }) as never;
    await run.advanceInSteps(70_000, 5_000);
    expect(run.callsOf("Heartbeat")).toHaveLength(0);
    // The idle timer kept going: the Heartbeat was tried again and again.
    expect(attempts).toBeGreaterThanOrEqual(3);
    // Not hung: the next CALL still goes out at once.
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification")).toHaveLength(1);
  });

  test("drops every other Heartbeat", async () => {
    let n = 0;
    const run = await start([
      {
        api: 1,
        id: "half",
        beforeSend: {
          Heartbeat: () => (++n % 2 === 0 ? { drop: true } : undefined),
        },
      },
    ]);
    await run.call("ChangeConfiguration", {
      key: "HeartbeatInterval",
      value: "20",
    });
    await run.advanceInSteps(100_000, 5_000);
    expect(n).toBeGreaterThanOrEqual(4);
    expect(run.callsOf("Heartbeat")).toHaveLength(Math.ceil(n / 2));
  });

  test("rewrites and drops MeterValues (triggered, so automatic)", async () => {
    let drop = false;
    const run = await start([
      driver,
      {
        api: 1,
        id: "meter",
        beforeSend: {
          MeterValues: (payload) =>
            drop
              ? { drop: true }
              : { ...payload, transactionId: payload.transactionId, tag: 1 },
        },
      },
    ]);
    await run.advanceInSteps(2_000, 500);
    await run.call("TriggerMessage", {
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    await run.settle();
    expect(run.callsOf("MeterValues")).toHaveLength(1);
    expect(run.callsOf("MeterValues")[0]!.payload).toMatchObject({ tag: 1 });
    drop = true;
    await run.call("TriggerMessage", {
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    await run.settle();
    expect(run.callsOf("MeterValues")).toHaveLength(1);
    // The charger is alive: the stop still goes out.
    run.cp.stopTransaction(run.cp.getConnector(1)!, "Local");
    await run.settle();
    expect(run.callsOf("StopTransaction")).toHaveLength(1);
  });

  test("drops StartTransaction: no frame, no hang, later CALLs flow", async () => {
    const run = await start([
      driver,
      {
        api: 1,
        id: "no-start",
        beforeSend: { StartTransaction: () => ({ drop: true }) },
      },
    ]);
    await run.advanceInSteps(3_000, 500);
    expect(run.callsOf("StartTransaction")).toHaveLength(0);
    run.cp.updateConnectorStatus(1, "Unavailable" as never);
    await run.settle();
    expect(
      run
        .callsOf("StatusNotification")
        .some(
          (f) => (f.payload as { status: string }).status === "Unavailable",
        ),
    ).toBe(true);
    // The serial queue is free: a Heartbeat goes out on request.
    await run.call("ChangeConfiguration", {
      key: "HeartbeatInterval",
      value: "20",
    });
    await run.advanceInSteps(25_000, 5_000);
    expect(run.callsOf("Heartbeat").length).toBeGreaterThanOrEqual(1);
  });

  test("a dropped ctx.send settles the caller as unanswered", async () => {
    const outcomes: string[] = [];
    const run = await start([
      {
        api: 1,
        id: "send",
        beforeSend: { DataTransfer: () => ({ drop: true }) },
        main: async (ctx) => {
          try {
            await ctx.send("DataTransfer", { vendorId: "x" });
            outcomes.push("answered");
          } catch (error) {
            outcomes.push((error as Error).name);
          }
        },
      },
    ]);
    await run.settle();
    expect(outcomes).toEqual(["OcppCallNoAnswerError"]);
    expect(run.callsOf("DataTransfer")).toHaveLength(0);
  });

  test("ctx.send and the ocppCall path are intercepted too", async () => {
    const run = await start([
      {
        api: 1,
        id: "send",
        beforeSend: {
          DataTransfer: (p) => ({ ...p, messageId: "changed" }),
        },
        main: async (ctx) => {
          await ctx.send("DataTransfer", { vendorId: "x", messageId: "orig" });
        },
      },
    ]);
    await run.settle();
    expect(run.callsOf("DataTransfer")[0]!.payload).toMatchObject({
      messageId: "changed",
    });
    const outcome = await run.cp.sendOcppCall({
      action: "DataTransfer",
      payload: { vendorId: "y", messageId: "orig" },
    });
    expect(outcome.kind).toBe("callResult");
    expect(run.callsOf("DataTransfer")[1]!.payload).toMatchObject({
      messageId: "changed",
    });
    expect((outcome as { sentFrame: string }).sentFrame).toContain("changed");
  });

  test("ctx.raw is outside the interception", async () => {
    const run = await start([
      {
        api: 1,
        id: "raw",
        requires: ["raw-frames"],
        beforeSend: { Heartbeat: () => ({ drop: true }) },
        main: async (ctx) => {
          ctx.raw(JSON.stringify([2, "raw-1", "Heartbeat", {}]));
        },
      },
    ]);
    await run.settle();
    expect(run.callsOf("Heartbeat")).toHaveLength(1);
  });

  test("a rewritten payload goes through the outgoing schema warning", async () => {
    const run = await start([
      {
        api: 1,
        id: "bad",
        beforeSend: { StatusNotification: (p) => ({ ...p, status: "Nope" }) },
      },
    ]);
    const warnings: string[] = [];
    const original = run.cp.logger.warn.bind(run.cp.logger);
    run.cp.logger.warn = ((message: string, ...rest: unknown[]) => {
      warnings.push(message);
      return (original as (...a: unknown[]) => unknown)(message, ...rest);
    }) as never;
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(warnings.some((w) => /Nope|status/.test(w))).toBe(true);
    // Still sent: the warning does not block (existing behavior).
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      status: "Nope",
    });
  });

  test("several behaviors chain in load order", async () => {
    const run = await start([
      {
        api: 1,
        id: "a",
        beforeSend: {
          StatusNotification: (p) => ({
            ...p,
            info: `${String(p.info ?? "")}a`,
          }),
        },
      },
      {
        api: 1,
        id: "b",
        beforeSend: {
          StatusNotification: (p) => ({
            ...p,
            info: `${String(p.info ?? "")}b`,
          }),
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      info: "ab",
    });
  });

  test("a throwing, async or malformed beforeSend leaves the CALL unchanged", async () => {
    const run = await start([
      {
        api: 1,
        id: "throws",
        beforeSend: {
          StatusNotification: () => {
            throw new Error("bug");
          },
        },
      },
      {
        api: 1,
        id: "async",
        beforeSend: {
          StatusNotification: (async () => ({ drop: true })) as never,
        },
      },
      {
        api: 1,
        id: "junk",
        beforeSend: { StatusNotification: (() => "nope") as never },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification")).toHaveLength(1);
  });

  test("the payload handed over is a copy: mutating it changes nothing", async () => {
    const run = await start([
      {
        api: 1,
        id: "mutate",
        beforeSend: {
          StatusNotification: (p) => {
            p.status = "Faulted";
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    expect(run.callsOf("StatusNotification").at(-1)!.payload).toMatchObject({
      status: "Preparing",
    });
  });

  test("a ctx.send from inside beforeSend goes out after the CALL it intercepts", async () => {
    const run = await start([
      {
        api: 1,
        id: "order",
        beforeSend: {
          StatusNotification: (_p, ctx) => {
            void ctx.send("DataTransfer", { vendorId: "from-hook" });
          },
        },
      },
    ]);
    run.cp.updateConnectorStatus(1, "Preparing" as never);
    await run.settle();
    const actions = run
      .frames()
      .filter((f) => f.dir === "CP>" && f.kind === "call")
      .map((f) => f.action);
    expect(actions).toEqual(["StatusNotification", "DataTransfer"]);
  });

  test("2.x: keyed by TransactionEvent or by the 1.6 spelling", async () => {
    const run = await start(
      [
        driver,
        {
          api: 1,
          id: "tx",
          beforeSend: {
            StartTransaction: (p) => ({ ...p, seen: "start" }),
            StopTransaction: () => ({ drop: true }),
          },
        },
      ],
      "2.0.1",
    );
    await run.advanceInSteps(2_000, 500);
    const events = run.callsOf("TransactionEvent");
    expect(events[0]!.payload).toMatchObject({
      eventType: "Started",
      seen: "start",
    });
    run.cp.stopTransaction(run.cp.getConnector(1)!, "Local");
    await run.settle();
    expect(
      run
        .callsOf("TransactionEvent")
        .some(
          (f) => (f.payload as { eventType: string }).eventType === "Ended",
        ),
    ).toBe(false);
  });

  test("a SOAP station refuses a behavior that uses beforeSend at load", async () => {
    const { ChargerEngine } =
      await import("../../cp/application/engine/ChargerEngine");
    const fakeHost = {
      ocppVersion: "OCPP-1.6S",
      behaviors: { register: () => () => undefined, release: () => [] },
      logger: { warn: () => undefined, info: () => undefined },
    } as never;
    const engine = new ChargerEngine({
      ...(fakeHost as object),
      clock: undefined,
    } as never);
    expect(() =>
      engine.loadBehavior({
        api: 1,
        id: "x",
        beforeSend: { Heartbeat: () => undefined },
      }),
    ).toThrow(/beforeSend.*OCPP-J.*SOAP/);
  });
});
