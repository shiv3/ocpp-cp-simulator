import { afterEach, expect, test } from "bun:test";
import { runBehavior, type BehaviorRun } from "../behavior/runBehavior";
import { parsePersistedEngineState } from "../../cp/application/engine/ChargerState";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

const saved = (behaviors: Record<string, unknown>) =>
  parsePersistedEngineState({
    schema: 1,
    firmware: { status: "Idle" },
    signedFirmware: { status: "Idle" },
    log: { status: "Idle" },
    diagnostics: { status: "Idle" },
    behaviors,
  });

test("a stored behavior id that names a member of every object is dropped", () => {
  const parsed = saved({
    constructor: { a: 1 },
    toString: { b: 2 },
    ok: { c: 3 },
  });
  expect(Object.keys(parsed!.behaviors)).toEqual(["ok"]);
});

test("a stored ctx.state key named __proto__ stays a plain key", async () => {
  const run = await runBehavior({
    version: "1.6",
    behaviors: [{ api: 1, id: "b" }],
  });
  runs.push(run);
  const before = Object.prototype.hasOwnProperty.call(
    Object.prototype,
    "polluted",
  );
  run.cp.engine.restoreState(
    parsePersistedEngineState(
      JSON.parse(
        '{"schema":1,"firmware":{"status":"Idle"},"signedFirmware":{"status":"Idle"},"log":{"status":"Idle"},"diagnostics":{"status":"Idle"},"behaviors":{"b":{"__proto__":{"polluted":true},"n":1}}}',
      ),
    )!,
  );
  const state = run.cp.engine.state.behaviors["b"]!;
  expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
  expect(Object.keys(state).sort()).toEqual(["__proto__", "n"]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(before).toBe(false);
});

test("restoring a state for the id constructor leaves the global Object alone", async () => {
  const run = await runBehavior({ version: "1.6", behaviors: [] });
  runs.push(run);
  const keys = Object.getOwnPropertyNames(Object);
  run.cp.engine.restoreState({
    schema: 1,
    firmware: { status: "Idle" },
    signedFirmware: { status: "Idle" },
    log: { status: "Idle" },
    diagnostics: { status: "Idle" },
    behaviors: { constructor: { marker: 1 } },
  } as never);
  expect(Object.getOwnPropertyNames(Object)).toEqual(keys);
  expect((Object as unknown as Record<string, unknown>).marker).toBeUndefined();
});
