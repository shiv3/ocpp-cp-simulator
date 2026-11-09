// Scenario schema 1.6, step 3 of #654: the bounded set of new nodes —
// callResponse accepted / rejected, notify, switch, $from roots (charger,
// connector, state), delay until and jitterSeconds, choice, setState.
import { afterEach, describe, expect, test } from "bun:test";
import type { Edge } from "@xyflow/react";
import type {
  ScenarioDefinition,
  ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
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
const step = (
  type: string,
  id: string,
  data: Record<string, unknown> = {},
): Step => ({ id, type, data });
const replaceTrigger = (action: string, extra = {}) =>
  step("csmsCallTrigger", `trigger-${action}`, {
    action,
    behavior: "replace",
    ...extra,
  });
const respond = (data: Record<string, unknown>) =>
  step("callResponse", "respond", data);
const notify = (data: Record<string, unknown>, id = "notify") =>
  step("notify", id, data);
const statuses = (r: BehaviorRun, action = "FirmwareStatusNotification") =>
  r.callsOf(action).map((f) => f.payload as Record<string, unknown>);

/** A graph with explicit edges, `[from, to, sourceHandle?]`, from `start`. */
function graph(
  steps: readonly Step[],
  edges: ReadonlyArray<readonly [string, string, string?]>,
): ScenarioDefinition {
  const nodes = [
    { id: "start", type: "start" },
    ...steps,
    { id: "end", type: "end" },
  ].map(
    (s) =>
      ({
        id: s.id,
        type: s.type,
        position: { x: 0, y: 0 },
        data: { label: s.id, ...(("data" in s && s.data) || {}) },
      }) as unknown as ScenarioNode,
  );
  return {
    id: "s-graph",
    name: "s-graph",
    targetType: "connector",
    targetId: 1,
    nodes,
    edges: edges.map(([source, target, sourceHandle]): Edge => ({
      id: `${source}->${target}:${sourceHandle ?? ""}`,
      source,
      target,
      ...(sourceHandle === undefined ? {} : { sourceHandle }),
    })),
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("callResponse accepted / rejected", () => {
  test.each([
    ["1.6", "UpdateFirmware", fw16, {}, undefined],
    [
      "1.6",
      "RemoteStartTransaction",
      { idTag: "T" },
      { status: "Accepted" },
      { status: "Rejected" },
    ],
    [
      "2.0.1",
      "UpdateFirmware",
      {
        requestId: 1,
        firmware: {
          location: "x",
          retrieveDateTime: "2020-01-01T00:00:00.000Z",
        },
      },
      { status: "Accepted" },
      { status: "Rejected" },
    ],
  ] as const)(
    "%s %s: the answer of the action on this version, no payload",
    async (version, action, request, accepted, rejected) => {
      run = await runBehavior({ version });
      startScenario(
        run,
        definition([replaceTrigger(action), respond({ kind: "accepted" })]),
      );
      await run.settle();
      const id = run.callNoWait(action, request);
      await run.settle();
      expect(answerTo(run, id)).toEqual({ kind: "result", payload: accepted });
      if (rejected === undefined) return;
      startScenario(
        run,
        definition(
          [replaceTrigger(action), respond({ kind: "rejected" })],
          "s-2",
        ),
      );
      await run.settle();
      const second = run.callNoWait(action, request);
      await run.settle();
      expect(answerTo(run, second)).toEqual({
        kind: "result",
        payload: rejected,
      });
    },
  );

  test("a station-level 1.6 action name is translated on 2.x (Reset)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    startScenario(
      run,
      definition([replaceTrigger("Reset"), respond({ kind: "accepted" })]),
    );
    await run.settle();
    const id = run.callNoWait("Reset", { type: "OnIdle" });
    await run.settle();
    expect(answerTo(run, id)).toEqual({
      kind: "result",
      payload: { status: "Accepted" },
    });
  });

  test("a payload next to accepted fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware"),
        respond({ kind: "accepted", payload: {} }),
      ]),
    );
    await run.settle();
    run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toMatch(/takes no payload/);
  });

  test("onBusy accepted answers the second CALL with the action's accepted answer", async () => {
    run = await runBehavior({ version: "1.6" });
    startScenario(
      run,
      definition([
        replaceTrigger("UpdateFirmware", { onBusy: { kind: "accepted" } }),
        step("delay", "hold", { delaySeconds: 60 }),
        respond({ kind: "accepted" }),
      ]),
    );
    await run.settle();
    run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    const second = run.callNoWait("UpdateFirmware", fw16);
    await run.settle();
    expect(answerTo(run, second)).toEqual({ kind: "result", payload: {} });
  });
});

describe("notify", () => {
  test.each([
    ["firmwareStatus", "Downloading", "FirmwareStatusNotification"],
    ["logStatus", "Uploading", "LogStatusNotification"],
    ["signedFirmwareStatus", "Downloaded", "SignedFirmwareStatusNotification"],
    ["diagnosticsStatus", "Uploading", "DiagnosticsStatusNotification"],
  ])("1.6 %s %s sends %s and goes on", async (kind, status, action) => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([notify({ kind, status, requestId: 7 })]),
    );
    await run.settle();
    expect(scenario.state()).toBe("completed");
    const [frame] = statuses(run, action);
    expect(frame?.status).toBe(status);
  });

  test("2.0.1: requestId from a $from of the run state; the CSMS answer is not awaited", async () => {
    run = await runBehavior({
      version: "2.0.1",
      responders: { FirmwareStatusNotification: () => "silent" },
    });
    const scenario = startScenario(
      run,
      definition([
        step("setState", "set", { key: "rid", value: 41 }),
        notify({
          kind: "firmwareStatus",
          status: "Installed",
          requestId: { $from: "state.rid" },
        }),
      ]),
    );
    await run.settle();
    expect(scenario.state()).toBe("completed");
    expect(statuses(run)).toEqual([{ status: "Installed", requestId: 41 }]);
  });

  test.each([
    [
      { kind: "firmwareStatus", status: "Bogus" },
      /status for firmwareStatus must be one of/,
    ],
    [{ kind: "nope", status: "Idle" }, /kind must be one of/],
    [
      { kind: "signedFirmwareStatus", status: "Downloaded" },
      /needs a requestId/,
    ],
    [{ kind: "logStatus", status: "Uploading", requestId: -1 }, /whole number/],
  ])("%j fails the run", async (data, message) => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(run, definition([notify(data)]));
    await run.settle();
    expect(scenario.state()).toBe("error");
    expect(scenario.error()).toMatch(message);
    expect(statuses(run)).toEqual([]);
  });
});

describe("switch", () => {
  const branchy = (value: unknown, cases: unknown[], handles: string[]) =>
    graph(
      [
        step("switch", "pick", { value, cases }),
        ...handles.map((h) =>
          notify(
            {
              kind: "logStatus",
              status: "Uploading",
              requestId: handles.indexOf(h),
            },
            `n-${h}`,
          ),
        ),
      ],
      [
        ["start", "pick"],
        ...handles.map((h) => ["pick", `n-${h}`, h] as const),
        ...handles.map((h) => [`n-${h}`, "end"] as const),
      ],
    );
  const picked = (r: BehaviorRun) =>
    statuses(r, "LogStatusNotification").map((p) => p.requestId);

  test("goes along the first equal case, else default", async () => {
    run = await runBehavior({ version: "1.6" });
    const handles = ["case-0", "case-1", "default"];
    // Available is the first case's value: the connector is Available.
    startScenario(
      run,
      branchy(
        { $from: "connector.status" },
        ["Charging", "Available"],
        handles,
      ),
    );
    await run.settle();
    expect(picked(run)).toEqual([1]);
    startScenario(
      run,
      branchy({ $from: "connector.status" }, ["Charging"], handles),
    );
    await run.settle();
    expect(picked(run)).toEqual([1, 2]);
  });

  test('equality never converts: 1 is not "1", key order does not matter', async () => {
    run = await runBehavior({ version: "1.6" });
    const handles = ["case-0", "case-1", "default"];
    startScenario(run, branchy(1, ["1", 1], handles));
    await run.settle();
    startScenario(
      run,
      branchy({ a: 1, b: [true, null] }, [{ b: [true, null], a: 1 }], handles),
    );
    await run.settle();
    expect(picked(run)).toEqual([1, 0]);
  });

  test("a chosen handle with no edge ends the branch, the run completes", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      graph(
        [
          step("switch", "pick", { value: "x", cases: ["y"] }),
          notify(
            { kind: "logStatus", status: "Uploading", requestId: 1 },
            "never",
          ),
        ],
        [
          ["start", "pick"],
          ["pick", "never", "case-0"],
          ["never", "end"],
        ],
      ),
    );
    await run.settle();
    expect(scenario.state()).toBe("completed");
    expect(picked(run)).toEqual([]);
  });

  test("a $from inside cases, or a missing path, fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const bad = startScenario(
      run,
      branchy("x", [{ $from: "state.a" }], ["case-0", "default"]),
    );
    await run.settle();
    expect(bad.error()).toMatch(/cases are JSON constants/);
    const missing = startScenario(
      run,
      branchy({ $from: "state.nothing" }, ["x"], ["case-0", "default"]),
    );
    await run.settle();
    expect(missing.error()).toMatch(/names nothing in the state of this run/);
  });
});

describe("$from roots", () => {
  test("charger and connector are read as ctx reports them; state keeps what setState stored", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const scenario = startScenario(
      run,
      definition([
        step("setState", "a", { key: "obj", value: { n: [10, 20] } }),
        step("ocppCall", "call", {
          action: "DataTransfer",
          payload: {
            vendorId: { $from: "charger.id" },
            messageId: { $from: "charger.ocppVersion" },
            data: {
              status: { $from: "connector.status" },
              id: { $from: "connector.id" },
              acceptedW: { $from: "connector.power.acceptedW" },
              second: { $from: "state.obj.n.1" },
            },
          },
        }),
      ]),
    );
    await run.settle();
    expect(scenario.error()).toBeUndefined();
    const [frame] = statuses(run, "DataTransfer");
    expect(frame).toEqual({
      vendorId: "CP-GOLDEN",
      messageId: "OCPP-2.0.1",
      data: { status: "Available", id: 1, acceptedW: 0, second: 20 },
    });
  });

  test("an unknown root names the four", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        step("setState", "a", { key: "k", value: { $from: "env.HOME" } }),
      ]),
    );
    await run.settle();
    expect(scenario.error()).toMatch(
      /must start with "call\.", "charger\.", "connector\." or "state\."/,
    );
  });

  test("setState refuses a bad key and a non-JSON value", async () => {
    run = await runBehavior({ version: "1.6" });
    const badKey = startScenario(
      run,
      definition([step("setState", "a", { key: "a.b", value: 1 })]),
    );
    await run.settle();
    expect(badKey.error()).toMatch(/key must be letters/);
  });

  test("the state is fresh for every start and shared by parallel branches", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      definition([
        [step("setState", "set", { key: "x", value: "from-branch-1" })],
        [
          step("delay", "wait", { delaySeconds: 1 }),
          notify({ kind: "logStatus", status: "Uploading", requestId: 1 }),
          step("switch", "gone", {
            value: { $from: "state.x" },
            cases: ["from-branch-1"],
          }),
        ],
      ]),
    );
    await run.advance(2000);
    expect(scenario.state()).toBe("completed");
  });
});

describe("delay until and jitterSeconds", () => {
  const delayAt = (data: Record<string, unknown>) =>
    definition([
      step("delay", "d", data),
      notify({ kind: "logStatus", status: "Uploaded", requestId: 1 }),
    ]);
  const sentAfter = async (
    r: BehaviorRun,
    def: ScenarioDefinition,
    upTo = 20_000,
  ) => {
    const t0 = r.clock.now();
    startScenario(r, def);
    for (let at = 0; at < upTo; at += 100) {
      await r.advance(100);
      if (statuses(r, "LogStatusNotification").length > 0)
        return r.clock.now() - t0;
    }
    return undefined;
  };

  test("until waits for the instant, or delaySeconds if that is longer, and a past instant adds nothing", async () => {
    run = await runBehavior({ version: "1.6" });
    const at = (ms: number) => new Date(run!.clock.now() + ms).toISOString();
    const until = await sentAfter(
      run,
      delayAt({ delaySeconds: 1, until: at(5000) }),
    );
    expect(until).toBeGreaterThanOrEqual(5000);
    expect(until).toBeLessThan(5300);
    const longer = await runBehavior({ version: "1.6" });
    try {
      const t = await sentAfter(
        longer,
        delayAt({
          delaySeconds: 3,
          until: new Date(longer.clock.now() + 1000).toISOString(),
        }),
      );
      expect(t).toBeGreaterThanOrEqual(3000);
      expect(t).toBeLessThan(3300);
      const past = await runBehavior({ version: "1.6" });
      try {
        const p = await sentAfter(
          past,
          delayAt({ delaySeconds: 1, until: "2000-01-01T00:00:00.000Z" }),
        );
        expect(p).toBeLessThan(1300);
      } finally {
        await past.dispose();
      }
    } finally {
      await longer.dispose();
    }
  });

  test("an until that is not a date fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      delayAt({ delaySeconds: 1, until: "tomorrow" }),
    );
    await run.settle();
    expect(scenario.error()).toMatch(/until must be an ISO-8601 date-time/);
  });

  test("jitter is seeded: one seed one wait, within 0..jitterSeconds, other seeds differ", async () => {
    const wait = async (seed: string) => {
      const r = await runBehavior({ version: "1.6", seed });
      try {
        return await sentAfter(
          r,
          delayAt({ delaySeconds: 1, jitterSeconds: 4 }),
        );
      } finally {
        await r.dispose();
      }
    };
    const a = await wait("seed-a");
    expect(a).toBeGreaterThanOrEqual(1000);
    expect(a).toBeLessThanOrEqual(5300);
    expect(await wait("seed-a")).toBe(a);
    const others = await Promise.all(["seed-b", "seed-c", "seed-d"].map(wait));
    expect(others.some((t) => t !== a)).toBe(true);
  });

  test("jitterSeconds below 0 fails the run", async () => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(
      run,
      delayAt({ delaySeconds: 1, jitterSeconds: -1 }),
    );
    await run.settle();
    expect(scenario.error()).toMatch(
      /jitterSeconds must be a number of at least 0/,
    );
  });
});

describe("choice", () => {
  const chooser = (options: unknown[]) =>
    graph(
      [
        step("choice", "pick", { options }),
        ...options.map((_, i) =>
          notify(
            { kind: "logStatus", status: "Uploading", requestId: i },
            `n-${i}`,
          ),
        ),
      ],
      [
        ["start", "pick"],
        ...options.map((_, i) => ["pick", `n-${i}`, `option-${i}`] as const),
        ...options.map((_, i) => [`n-${i}`, "end"] as const),
      ],
    );
  const pickOf = async (seed: string, options: unknown[]) => {
    const r = await runBehavior({ version: "1.6", seed });
    try {
      startScenario(r, chooser(options));
      await r.settle();
      return statuses(r, "LogStatusNotification").map((p) => p.requestId);
    } finally {
      await r.dispose();
    }
  };

  test("the same seed gives the same pick, and over seeds every option is drawn", async () => {
    const seeds = Array.from({ length: 10 }, (_, i) => `seed-${i}`);
    const first = await Promise.all(seeds.map((s) => pickOf(s, [{}, {}, {}])));
    const again = await Promise.all(seeds.map((s) => pickOf(s, [{}, {}, {}])));
    expect(again).toEqual(first);
    expect(first.every((p) => p.length === 1)).toBe(true);
    expect(new Set(first.flat()).size).toBeGreaterThan(1);
  });

  test("a weight shifts the draw", async () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `w-${i}`);
    const picks = (
      await Promise.all(
        seeds.map((s) => pickOf(s, [{ weight: 1000 }, { weight: 0.001 }])),
      )
    ).flat();
    expect(picks.filter((p) => p === 0).length).toBeGreaterThanOrEqual(11);
  });

  test.each([
    [[{}], /at least two options/],
    [[{ weight: 0 }, {}], /weight must be a number above 0/],
  ])("options %j fail the run", async (options, message) => {
    run = await runBehavior({ version: "1.6" });
    const scenario = startScenario(run, chooser(options as unknown[]));
    await run.settle();
    expect(scenario.error()).toMatch(message);
  });
});
