import { describe, expect, it } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioDefinition, ScenarioNode } from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/** `$match` cases of a switch (schema 1.7). */

const start = () => node("start", ScenarioNodeType.START, { label: "Start" });
const mark = (id: string) =>
  node(id, ScenarioNodeType.SET_STATE, { label: id, key: id, value: true });

/** start → seed (setState k = value) → sw → one mark per case and default. */
function switchOn(
  seed: unknown,
  valueFrom: string,
  cases: unknown[],
  extra: ScenarioNode[] = [],
): ScenarioDefinition {
  const nodes: ScenarioNode[] = [
    start(),
    ...(seed === undefined
      ? []
      : [
          node("seed", ScenarioNodeType.SET_STATE, {
            label: "seed",
            key: "k",
            value: seed,
          }),
        ]),
    node("sw", ScenarioNodeType.SWITCH, {
      label: "sw",
      value: { $from: valueFrom },
      cases,
    }),
    ...cases.map((_, i) => mark(`m${i}`)),
    mark("dflt"),
    ...extra,
  ];
  const edges = [
    { id: "e0", source: "start", target: seed === undefined ? "sw" : "seed" },
    ...(seed === undefined ? [] : [{ id: "e1", source: "seed", target: "sw" }]),
    ...cases.map((_, i) => ({
      id: `c${i}`,
      source: "sw",
      target: `m${i}`,
      sourceHandle: `case-${i}`,
    })),
    { id: "d", source: "sw", target: "dflt", sourceHandle: "default" },
  ];
  return { ...linearScenario("match", []), nodes, edges };
}

async function run(scenario: ScenarioDefinition) {
  const logs: string[] = [];
  const errors: Error[] = [];
  const executor = new ScenarioExecutor(scenario, {
    log: (m) => logs.push(m),
    onError: (e) => errors.push(e),
  });
  await executor.start();
  return { logs, errors, executor };
}

const picked = (r: { logs: string[] }) =>
  r.logs.find((l) => l.startsWith("Switch on "))?.split(" → ")[1];

describe("switch $match cases (schema 1.7)", () => {
  it("picks the first case that matches, constants and matchers mixed", async () => {
    const cases = [
      "Accepted",
      { $match: { in: ["Blocked", "Invalid", "Expired"] } },
      { $match: { gte: 80 } },
    ];
    const at = async (v: unknown) =>
      picked(await run(switchOn(v, "state.k", cases)));
    expect(await at("Accepted")).toBe("case-0");
    expect(await at("Expired")).toBe("case-1");
    expect(await at(90)).toBe("case-2");
    expect(await at(79)).toBe("default");
    expect(await at("Charging")).toBe("default");
  });

  it("compares a numeric string with an ordering operator (a Configuration value)", async () => {
    const r = await run(switchOn("60", "state.k", [{ $match: { gte: 60 } }]));
    expect(picked(r)).toBe("case-0");
    expect(r.errors).toEqual([]);
  });

  it("a plain object with $match beside other keys stays a constant", async () => {
    const constant = { $match: { gte: 1 }, x: 1 };
    const r = await run(switchOn(constant, "state.k", [constant]));
    expect(picked(r)).toBe("case-0");
  });

  it("goes to an { exists: false } case when the path names nothing", async () => {
    const r = await run(
      switchOn(undefined, "state.nothing", [
        "x",
        { $match: { exists: false } },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(picked(r)).toBe("case-1");
    expect(r.logs).toContain("Switch on (missing) → case-1");
  });

  it("exists: true picks any present value, null included", async () => {
    const r = await run(
      switchOn(null, "state.k", [{ $match: { exists: true } }]),
    );
    expect(picked(r)).toBe("case-0");
  });

  it("fails as before when the path names nothing and no case is { exists: false }", async () => {
    const r = await run(
      switchOn(undefined, "state.nothing", ["x", { $match: { gte: 1 } }]),
    );
    expect(r.executor.getContext().state).toBe("error");
    expect(r.errors[0]?.message).toBe(
      'switch: $from "state.nothing" names nothing in the state of this run',
    );
  });

  it("still fails when a root has nothing to read, even with an exists case", async () => {
    const r = await run(
      switchOn(undefined, "response.kind", [{ $match: { exists: false } }]),
    );
    expect(r.errors[0]?.message).toContain(
      "needs the answer to an ocppCall earlier in this branch",
    );
  });

  it("fails the switch (not the load) on an unknown operator or a bad argument", async () => {
    const unknown = await run(
      switchOn("a", "state.k", [{ $match: { regex: "a" } }]),
    );
    expect(unknown.executor.getContext().state).toBe("error");
    expect(unknown.errors[0]?.message).toContain(
      'cases[0]: $match: unknown operator "regex"',
    );
    const bad = await run(
      switchOn("a", "state.k", ["a", { $match: { in: "a" } }]),
    );
    expect(bad.errors[0]?.message).toContain(
      'cases[1]: $match: "in" takes an array',
    );
  });
});
