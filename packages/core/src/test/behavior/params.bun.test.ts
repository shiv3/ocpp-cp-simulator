// Behavior params and the scenario-side disable (#654, step 1): ctx.params,
// arm-time validation that refuses and never coerces, schema 1.6 useBehavior
// params / mode, and the params of the built-in defaults.
import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { answerTo, definition, startScenario, type Step } from "./runScenario";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const fw16 = {
  location: "http://fw.example/f.bin",
  retrieveDate: "2020-01-01T00:00:00.000Z",
};
const use = (
  behaviorId: string,
  extra: Record<string, unknown> = {},
  id = `use-${behaviorId}`,
): Step => ({ id, type: "useBehavior", data: { behaviorId, ...extra } });
const wait = (seconds: number, id = `wait-${seconds}`): Step => ({
  id,
  type: "delay",
  data: { delaySeconds: seconds },
});
const statuses = (r: BehaviorRun, action = "FirmwareStatusNotification") =>
  r.callsOf(action).map((f) => (f.payload as { status: string }).status);

const knob: Behavior = {
  api: 1,
  id: "knob",
  params: {
    schema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 0, maximum: 10 },
        label: { type: "string", enum: ["a", "b"] },
      },
    },
    defaults: { count: 1, label: "a" },
  },
  onCall: {
    Reset: {
      mode: "replace",
      handle: (_req, ctx) => ({
        response: { status: "Accepted" },
        after: async () => {
          ctx.log(`params ${JSON.stringify(ctx.params)}`);
        },
      }),
    },
  },
};

describe("ctx.params", () => {
  test("a behavior reads its defaults, then the selection's keys over them", async () => {
    const seen: unknown[] = [];
    const probe: Behavior = {
      ...knob,
      id: "probe",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_req, ctx) => {
            seen.push({ ...ctx.params });
            return { response: { status: "Accepted" } };
          },
        },
      },
    };
    run = await runBehavior({ version: "1.6" });
    run.cp.loadBehavior(probe, { params: { count: 7 } });
    await run.call("Reset", { type: "Soft" });
    expect(seen).toEqual([{ count: 7, label: "a" }]);
  });

  test("is read-only", async () => {
    let frozen = false;
    const probe: Behavior = {
      ...knob,
      id: "probe",
      onCall: {
        Reset: {
          mode: "replace",
          handle: (_req, ctx) => {
            frozen = Object.isFrozen(ctx.params);
            expect(() => {
              (ctx.params as Record<string, unknown>).count = 9;
            }).toThrow();
            return { response: { status: "Accepted" } };
          },
        },
      },
    };
    run = await runBehavior({ version: "1.6" });
    run.cp.loadBehavior(probe);
    await run.call("Reset", { type: "Soft" });
    expect(frozen).toBe(true);
  });

  test("a behavior without params gets {} and refuses params", async () => {
    run = await runBehavior({ version: "1.6" });
    const plain: Behavior = { api: 1, id: "plain" };
    expect(() => run!.cp.loadBehavior(plain, { params: { a: 1 } })).toThrow(
      "declares no params",
    );
    expect(run.cp.engine.behaviorIds).not.toContain("plain");
  });

  test("refuses a value of the wrong type, an unknown key and a range miss; nothing is loaded", async () => {
    run = await runBehavior({ version: "1.6" });
    for (const [params, message] of [
      [{ count: "2" }, "expected integer"],
      [{ count: 1.5 }, "expected integer"],
      [{ count: 11 }, "above the maximum"],
      [{ nope: 1 }, "unknown parameter"],
      [{ label: "c" }, "must be one of"],
    ] as const) {
      expect(() => run!.cp.loadBehavior(knob, { params })).toThrow(message);
    }
    expect(run.cp.engine.behaviorIds).toEqual([]);
  });

  test("params that are not JSON are refused", async () => {
    run = await runBehavior({ version: "1.6" });
    expect(() =>
      run!.cp.loadBehavior(knob, {
        params: { count: (() => 1) as unknown as number },
      }),
    ).toThrow("not JSON");
  });

  test("a behavior whose defaults break its own schema does not load", async () => {
    run = await runBehavior({ version: "1.6" });
    const bad: Behavior = {
      ...knob,
      id: "bad",
      params: { ...knob.params!, defaults: { count: "x" } },
    };
    expect(() => run!.cp.loadBehavior(bad)).toThrow("params.defaults");
    const loose: Behavior = {
      ...knob,
      id: "loose",
      params: {
        schema: { type: "object", pattern: "x" } as never,
        defaults: {},
      },
    };
    expect(() => run!.cp.loadBehavior(loose)).toThrow('keyword "pattern"');
  });
});

describe("useBehavior params (schema 1.6)", () => {
  test("default.firmware: stepMs, failAt and startAt change the train, and end with the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        use("default.firmware", {
          params: { stepMs: 500, failAt: "InstallationFailed" },
        }),
        wait(10),
      ]),
    );
    await run.settle();
    await run.call("UpdateFirmware", fw16);
    await run.advance(1500);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "InstallationFailed",
    ]);
    await run.advance(10_000);
    expect(scenario.state()).toBe("completed");
    // The run is over: the next update is the plain, happy train.
    await run.call("UpdateFirmware", fw16);
    await run.advance(7000);
    expect(statuses(run).slice(4)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("startAt now ignores a retrieveDate in the future", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        use("default.firmware", { params: { startAt: "now", stepMs: 100 } }),
        wait(30),
      ]),
    );
    await run.settle();
    await run.call("UpdateFirmware", {
      ...fw16,
      retrieveDate: "2099-01-01T00:00:00.000Z",
    });
    await run.advance(1000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("failAt wins over the one-shot configuration key, which is still consumed", async () => {
    run = await runBehavior({ version: "1.6" });
    run.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    startScenario(
      run,
      definition([
        use("default.firmware", { params: { failAt: "InstallationFailed" } }),
        wait(60),
      ]),
    );
    await run.settle();
    await run.call("UpdateFirmware", fw16);
    await run.advance(8000);
    expect(statuses(run).at(-1)).toBe("InstallationFailed");
    expect(
      run.cp.configuration.getString("SimulatedFirmwareUpdateFailure"),
    ).toBe("");
  });

  test("the configuration key alone still diverts (the alias)", async () => {
    run = await runBehavior({ version: "1.6" });
    run.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    await run.call("UpdateFirmware", fw16);
    await run.advance(8000);
    expect(statuses(run)).toEqual(["Downloading", "DownloadFailed"]);
  });

  test("a bad value fails the run before anything is armed", async () => {
    run = await runBehavior({ version: "1.6" });
    for (const [params, message] of [
      [{ stepMs: "2000" }, "expected integer"],
      [{ stepMs: -1 }, "below the minimum"],
      [{ failAt: "Installing" }, "must be one of"],
      [{ speed: 3 }, "unknown parameter"],
    ] as const) {
      const bad = startScenario(
        run,
        definition([use("default.firmware", { params })], `s-${message}`),
      );
      await run.settle();
      expect(bad.state()).toBe("error");
      expect(bad.error()).toContain(message);
    }
    await run.call("UpdateFirmware", fw16);
    await run.advance(7000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("params must be a JSON object", async () => {
    run = await runBehavior({ version: "1.6" });
    const bad = startScenario(
      run,
      definition([use("default.firmware", { params: [1, 2] })]),
    );
    await run.settle();
    expect(bad.state()).toBe("error");
    expect(bad.error()).toContain("params must be a JSON object");
  });

  test("a dormant code behavior reads the run's params; two runs stack, the newest key wins, each ends alone", async () => {
    run = await runBehavior({ version: "1.6" });
    const seen: unknown[] = [];
    run.cp.loadBehavior(
      {
        ...knob,
        onCall: {
          Reset: {
            mode: "replace",
            handle: (_req, ctx) => {
              seen.push({ ...ctx.params });
              return { response: { status: "Accepted" } };
            },
          },
        },
      },
      { dormant: true, params: { label: "b" } },
    );
    const first = startScenario(
      run,
      definition(
        [use("knob", { params: { count: 2 } }, "use-first"), wait(20)],
        "first",
      ),
    );
    await run.settle();
    const second = startScenario(
      run,
      definition(
        [use("knob", { params: { count: 3 } }, "use-second"), wait(5)],
        "second",
      ),
    );
    await run.settle();
    await run.call("Reset", { type: "Soft" });
    await run.advance(5000);
    expect(second.state()).toBe("completed");
    await run.call("Reset", { type: "Soft" });
    await run.advance(15_000);
    expect(first.state()).toBe("completed");
    expect(seen).toEqual([
      { count: 3, label: "b" },
      { count: 2, label: "b" },
    ]);
  });

  test("default.logs uploadMs, default.signedFirmware stepMs", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        use("default.logs", { params: { uploadMs: 5000 } }),
        use("default.signedFirmware", { params: { stepMs: 100 } }, "u2"),
        wait(60),
      ]),
    );
    await run.settle();
    await run.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 1,
      log: { remoteLocation: "http://x/y" },
    });
    await run.advance(4999);
    expect(statuses(run, "LogStatusNotification")).toEqual(["Uploading"]);
    await run.advance(1);
    expect(statuses(run, "LogStatusNotification")).toEqual([
      "Uploading",
      "Uploaded",
    ]);
    await run.call("SignedUpdateFirmware", {
      requestId: 2,
      firmware: {
        location: "http://x/f",
        retrieveDateTime: "2020-01-01T00:00:00.000Z",
        signingCertificate: "c",
        signature: "s",
      },
    });
    await run.advance(600);
    expect(statuses(run, "SignedFirmwareStatusNotification")).toHaveLength(5);
  });

  test("default.reset delayMs holds the boot back", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        use("default.reset", { params: { delayMs: 4000 } }),
        wait(60),
      ]),
    );
    await run.settle();
    await run.call("Reset", { type: "Soft" });
    await run.settle();
    const boots = () => run!.callsOf("BootNotification").length;
    expect(boots()).toBe(0);
    await run.advance(3999);
    expect(boots()).toBe(0);
    await run.advance(1);
    await run.advance(1000);
    expect(boots()).toBe(1);
  });

  test("default.unlock outcome, on both versions", async () => {
    for (const version of ["1.6", "2.0.1"] as const) {
      run = await runBehavior({ version });
      startScenario(
        run,
        definition([
          use("default.unlock", { params: { outcome: "UnlockFailed" } }),
          wait(60),
        ]),
      );
      await run.settle();
      const reply = await run.call(
        "UnlockConnector",
        version === "1.6" ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
      );
      expect(reply.payload).toEqual({ status: "UnlockFailed" });
      await run.dispose();
      run = undefined;
    }
  });
});

describe("useBehavior mode disable", () => {
  test("answers Accepted with no follow-up for the run, then lets go", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([use("default.firmware", { mode: "disable" }), wait(30)]),
    );
    await run.settle();
    const id = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    expect(answerTo(run, id)).toEqual({ kind: "result", payload: {} });
    await run.advance(20_000);
    expect(statuses(run)).toEqual([]);
    await run.advance(10_000);
    expect(scenario.state()).toBe("completed");
    await run.call("UpdateFirmware", fw16);
    await run.advance(7000);
    expect(statuses(run)).toHaveLength(4);
  });

  test("outranks a loaded code behavior for the same action", async () => {
    run = await runBehavior({
      version: "1.6",
      behaviors: [
        {
          api: 1,
          id: "refuse-reset",
          onCall: {
            Reset: {
              mode: "replace",
              handle: () => ({ response: { status: "Rejected" } }),
            },
          },
        },
      ],
    });
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Rejected",
    });
    startScenario(
      run,
      definition([use("refuse-reset", { mode: "disable" }), wait(10)]),
    );
    await run.settle();
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Accepted",
    });
    await run.advance(10_000);
    expect((await run.call("Reset", { type: "Soft" })).payload).toEqual({
      status: "Rejected",
    });
  });

  test("uses the answer of the station's version", async () => {
    run = await runBehavior({ version: "2.0.1" });
    startScenario(
      run,
      definition([use("default.firmware", { mode: "disable" }), wait(10)]),
    );
    await run.settle();
    const reply = await run.call("UpdateFirmware", {
      requestId: 1,
      firmware: { location: "http://x/f", retrieveDateTime: fw16.retrieveDate },
    });
    expect(reply.payload).toEqual({ status: "Accepted" });
  });

  test("takes no params, and refuses an unknown id or mode", async () => {
    run = await runBehavior({ version: "1.6" });
    const withParams = startScenario(
      run,
      definition([
        use("default.firmware", { mode: "disable", params: { stepMs: 1 } }),
      ]),
    );
    await run.settle();
    expect(withParams.error()).toContain('mode "disable" takes no params');
    const unknown = startScenario(
      run,
      definition([use("nope", { mode: "disable" })], "u"),
    );
    await run.settle();
    expect(unknown.error()).toContain('No behavior with id "nope"');
    const mode = startScenario(
      run,
      definition([use("default.firmware", { mode: "off" })], "m"),
    );
    await run.settle();
    expect(mode.error()).toContain('mode must be "use" or "disable"');
  });
});
