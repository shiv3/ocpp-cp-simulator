import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const fw16 = {
  retrieveDate: "2030-01-01T00:00:00.000Z",
  location: "http://fw.example/f.bin",
};

describe("ChargerEngine on a virtual clock", () => {
  test("a replace behavior owns UpdateFirmware and the default train does not run", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "custom-fw",
      onCall: {
        UpdateFirmware: {
          mode: "replace",
          handle: (_req, ctx) => ({
            response: {},
            after: async () => {
              await ctx.sleep(500);
              ctx.notify.firmwareStatus("DownloadFailed");
            },
          }),
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    const answer = await run.call("UpdateFirmware", fw16);
    expect(answer.kind).toBe("result");
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
    await run.advance(499);
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
    await run.advance(1);
    const sent = run.callsOf("FirmwareStatusNotification");
    expect(sent.map((f) => f.payload)).toEqual([{ status: "DownloadFailed" }]);
    await run.advance(10_000);
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(1);
    expect(run.cp.engine.state.firmware.status).toBe("DownloadFailed");
  });

  test("the same seed gives the same effect hash", async () => {
    const make = (): Behavior => ({
      api: 1,
      id: "jitter",
      onCall: {
        UpdateFirmware: {
          mode: "replace",
          handle: (_req, ctx) => ({
            response: {},
            after: async () => {
              const rng = ctx.random("delay");
              await ctx.sleep(rng.int(100, 900));
              ctx.notify.firmwareStatus("Downloading");
              await ctx.sleep(rng.int(100, 900));
              ctx.notify.firmwareStatus("Installed");
            },
          }),
        },
      },
    });
    const hashes: string[] = [];
    for (const seed of ["a", "a"]) {
      const r = await runBehavior({
        version: "1.6",
        behaviors: [make()],
        seed,
      });
      await r.call("UpdateFirmware", fw16);
      await r.advance(2000);
      hashes.push(r.effectHash());
      await r.dispose();
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});

describe("loading behaviors", () => {
  test("a duplicate id and an unmet capability are refused", async () => {
    run = await runBehavior({ version: "1.6" });
    const b: Behavior = { api: 1, id: "x" };
    run.cp.loadBehavior(b);
    expect(() => run!.cp.loadBehavior(b)).toThrow(/already loaded/);
    expect(() =>
      run!.cp.loadBehavior({ api: 1, id: "y", requires: ["ocpp2.x"] }),
    ).toThrow(/requires ocpp2.x/);
    expect(run.cp.engine.behaviorIds).toEqual(["x"]);
  });

  test("ctx.state is held by the engine and survives a snapshot", async () => {
    run = await runBehavior({
      version: "1.6",
      behaviors: [
        {
          api: 1,
          id: "counter",
          onCall: {
            UpdateFirmware: {
              mode: "replace",
              handle: (_req, ctx) => {
                ctx.state.count = Number(ctx.state.count ?? 0) + 1;
                return { response: {} };
              },
            },
          },
        },
      ],
    });
    await run.call("UpdateFirmware", fw16);
    await run.call("UpdateFirmware", fw16);
    expect(run.cp.engine.snapshot().behaviors.counter).toEqual({ count: 2 });
  });

  test("an invalid response is refused with InternalError unless validation is skipped", async () => {
    run = await runBehavior({
      version: "1.6",
      behaviors: [
        {
          api: 1,
          id: "bad",
          onCall: {
            Reset: {
              mode: "replace",
              handle: () => ({ response: { status: "Maybe" } }),
            },
            UnlockConnector: {
              mode: "replace",
              handle: () => ({
                response: { status: "Maybe" },
                skipValidation: true,
              }),
            },
          },
        },
      ],
    });
    const refused = await run.call("Reset", { type: "Soft" });
    expect(refused.kind).toBe("error");
    expect((refused.payload as { code: string }).code).toBe("InternalError");
    const sent = await run.call("UnlockConnector", { connectorId: 1 });
    expect(sent.kind).toBe("result");
    expect(sent.payload).toEqual({ status: "Maybe" });
  });
});
