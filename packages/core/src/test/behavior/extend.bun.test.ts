import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const past = "2020-01-01T00:00:00.000Z";
const fw16 = { location: "http://fw.example/f.bin", retrieveDate: past };
const fw201 = {
  requestId: 31,
  firmware: { location: "http://fw.example/f.bin", retrieveDateTime: past },
};

const statuses = (r: BehaviorRun, action: string): unknown[] =>
  r.callsOf(action).map((f) => (f.payload as { status: string }).status);

describe("extend mode: ctx.defaultBehavior", () => {
  test("1.6: the default response and train run, the handler adds its own follow-up after them", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "wrap-fw",
      onCall: {
        UpdateFirmware: {
          mode: "extend",
          handle: (req, ctx) => {
            const response = ctx.defaultBehavior(req);
            return {
              response,
              after: async () => {
                ctx.notify.firmwareStatus("Idle");
              },
            };
          },
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    const answer = await run.call("UpdateFirmware", fw16);
    expect(answer.payload).toEqual({});
    // Both follow-ups start in the turn of the settlement, default first; the
    // train waits for its (zero) start delay, so the user's report is sent first.
    await run.advance(8000);
    expect(statuses(run, "FirmwareStatusNotification")).toEqual([
      "Idle",
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("1.6: the handler may change what the default sees", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "late-fw",
      onCall: {
        UpdateFirmware: {
          mode: "extend",
          handle: (req, ctx) => ({
            response: ctx.defaultBehavior({
              ...(req as object),
              retrieveDate: new Date(ctx.now() + 3000).toISOString(),
            }),
          }),
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    await run.call("UpdateFirmware", fw16);
    await run.advance(2999);
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
    await run.advance(1);
    expect(statuses(run, "FirmwareStatusNotification")).toEqual([
      "Downloading",
    ]);
  });

  test("2.0.1: the ack-only default is extended into a status train by the user", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "opt-in-fw",
      onCall: {
        UpdateFirmware: {
          mode: "extend",
          handle: (req, ctx) => {
            const { requestId } = req as { requestId: number };
            return {
              response: ctx.defaultBehavior(req),
              after: async () => {
                ctx.notify.firmwareStatus("Downloading", { requestId });
                await ctx.sleep(1000);
                ctx.notify.firmwareStatus("Installed", { requestId });
              },
            };
          },
        },
      },
    };
    run = await runBehavior({ version: "2.0.1", behaviors: [behavior] });
    const answer = await run.call("UpdateFirmware", fw201);
    expect(answer.payload).toEqual({ status: "Accepted" });
    await run.advance(1000);
    expect(
      run.callsOf("FirmwareStatusNotification").map((f) => f.payload),
    ).toEqual([
      { status: "Downloading", requestId: 31 },
      { status: "Installed", requestId: 31 },
    ]);
    // The default remembered the request id.
    expect(run.cp.lastFirmwareRequestId).toBe(31);
  });

  test("2.0.1: without a behavior the same call stays ack-only", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const answer = await run.call("UpdateFirmware", fw201);
    expect(answer.payload).toEqual({ status: "Accepted" });
    await run.advance(20_000);
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
  });

  test("calling the default commits to its effect", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "refuse-but-reset",
      onCall: {
        Reset: {
          mode: "extend",
          handle: (req, ctx) => {
            ctx.defaultBehavior(req);
            return { response: { status: "Rejected" } };
          },
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    const answer = await run.call("Reset", { type: "Soft" });
    expect(answer.payload).toEqual({ status: "Rejected" });
    // The default's Soft reset boots the station again.
    await run.settle();
    expect(run.callsOf("BootNotification")).toHaveLength(1);
  });

  test("ctx.defaultBehavior outside an extend handler is an error the CSMS sees", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "wrong-mode",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (req, ctx) => ({ response: ctx.defaultBehavior(req) }),
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    const answer = await run.call("Reset", { type: "Soft" });
    expect(answer.kind).toBe("error");
    expect((answer.payload as { code: string }).code).toBe("InternalError");
  });

  test("the follow-up of the default is skipped, with the user's, when the answer is not delivered", async () => {
    const behavior: Behavior = {
      api: 1,
      id: "slow-answer",
      onCall: {
        UpdateFirmware: {
          mode: "extend",
          handle: async (req, ctx) => {
            const response = ctx.defaultBehavior(req);
            await ctx.sleep(500);
            return { response };
          },
        },
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [behavior] });
    const pending = run.callNoWait("UpdateFirmware", fw16);
    expect(pending).toBeDefined();
    await run.settle();
    run.cp.disconnect();
    await run.advance(10_000);
    expect(run.callsOf("FirmwareStatusNotification")).toHaveLength(0);
  });
});
