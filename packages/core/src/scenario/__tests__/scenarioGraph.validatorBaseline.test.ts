/**
 * `validateScenarioGraph` must report exactly what it reported before it was
 * rebuilt on the lowered program (`scenarioGraph.ts`). The baseline in
 * `__fixtures__/validateScenarioGraph.baseline.json` was recorded from the
 * validator of #829, before it was touched, over: every shipped template,
 * every `docs/examples/scenarios/*.json`, and a seeded corpus of messy graphs
 * (`graphFuzz.ts`).
 *
 * One deliberate exception, re-recorded with the change: graphs with two
 * nodes of the same id (`fuzz-dup:*`, 24 of 100 changed). The old validator
 * resolved such an id to the *last* node; the executor (`nodes.find`) and so
 * the lowered program resolve it to the *first*.
 *
 * Later deliberate changes of the validator, re-recorded with them; every
 * other entry is byte-identical to the recording from #829. Two from the
 * review of #854:
 *
 * - Switch / choice edges (125 entries): the validator follows only edges
 *   whose `sourceHandle` the node can pick (`pickableHandles`), as the
 *   executor does. +219 `unpickableHandle` (new code), +14 `unreachable`
 *   (nodes reached only through such edges), and 5 CALL findings gone that
 *   only an edge the executor never takes led to (3 `noCallHeld`, 1
 *   `callAlreadyAnswered`, 1 `callLeftOpen`).
 * - A second START (26 entries): reachability is seeded from the origin
 *   only, and a non-origin START with several edges is `extraOutgoing`
 *   (+18 `unreachable`, +23 `extraOutgoing`).
 *
 * Together the two add 32 `unreachable` (1082 → 1114): 14 from the handle
 * rule, 18 from seeding the origin only once that rule is in.
 *
 * And one from the follow-up review of #854:
 *
 * - Several edges on one handle of a switch / choice (8 entries: `fuzz:42`,
 *   `fuzz:179`, `fuzz:217`, `fuzz:291`, `fuzz:306`, `fuzz:328`,
 *   `fuzz-dup:5`, `fuzz-dup:70`): every edge after the first one of a
 *   handle is `duplicateHandle` (+8, new code) and no longer counts for
 *   reachability, as the executor never takes it (the CALL check already
 *   followed only the first). No `unreachable` of the corpus changed with it.
 *
 * Re-record (`RECORD_BASELINE=1`) only from code whose diagnostics are meant
 * to stay; a diff here is a behaviour change of the validator.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scenarioTemplates } from "../../utils/scenarioTemplates";
import { validateScenarioGraph } from "../scenarioGraphValidator";
import { fuzzGraphs, type FuzzOptions } from "./graphFuzz";

const BASELINE = fileURLToPath(
  new URL(
    "./__fixtures__/validateScenarioGraph.baseline.json",
    import.meta.url,
  ),
);
const EXAMPLES = fileURLToPath(
  new URL("../../../../../docs/examples/scenarios", import.meta.url),
);

const fuzzOptions: FuzzOptions = {
  types: [
    "delay",
    "statusChange",
    "switch",
    "choice",
    "csmsCallTrigger",
    "callResponse",
    "ocppCall",
    "setState",
    "bogus",
  ],
  dataFor: (type, rand) => {
    switch (type) {
      case "csmsCallTrigger":
        return {
          action: "Reset",
          ...(rand() < 0.7 ? { behavior: "replace" } : {}),
        };
      case "callResponse":
        return { kind: "result" };
      case "ocppCall":
        return {
          action: "DataTransfer",
          payload: {
            x: { $from: rand() < 0.6 ? "call.messageId" : "state.k" },
          },
        };
      case "switch":
        return { value: 0, cases: [0] };
      case "choice":
        return { options: [{}, {}] };
      default:
        return {};
    }
  },
};

type GraphDef = Parameters<typeof validateScenarioGraph>[0];

function corpus(): Array<[string, GraphDef]> {
  const entries: Array<[string, GraphDef]> = [];
  for (const template of scenarioTemplates) {
    entries.push([
      `template:${template.id}`,
      template.createScenario("cp", null),
    ]);
    entries.push([
      `template:${template.id}:c1`,
      template.createScenario("cp", 1),
    ]);
  }
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"))) {
    entries.push([
      `example:${file}`,
      JSON.parse(readFileSync(join(EXAMPLES, file), "utf-8")) as GraphDef,
    ]);
  }
  fuzzGraphs(400, 829, fuzzOptions).forEach((g, i) =>
    entries.push([`fuzz:${i}`, g]),
  );
  fuzzGraphs(100, 830, { ...fuzzOptions, duplicateIds: true }).forEach((g, i) =>
    entries.push([`fuzz-dup:${i}`, g]),
  );
  // Hand-written graphs for codes the seeded corpus no longer reaches (added
  // with the review of #854: its only `callAlreadyAnswered` came through a
  // switch edge the executor never takes).
  entries.push([
    "fixed:callAlreadyAnswered",
    {
      nodes: [
        { id: "s", type: "start" },
        {
          id: "t",
          type: "csmsCallTrigger",
          data: { action: "Reset", behavior: "replace" },
        },
        { id: "r1", type: "callResponse", data: { kind: "result" } },
        { id: "r2", type: "callResponse", data: { kind: "result" } },
      ],
      edges: [
        { id: "e0", source: "s", target: "t" },
        { id: "e1", source: "t", target: "r1" },
        { id: "e2", source: "r1", target: "r2" },
      ],
    },
  ]);
  return entries;
}

/** One line per diagnostic, in the order the validator reports them. */
const render = (def: GraphDef): string[] =>
  validateScenarioGraph(def).map((d) =>
    [d.code, d.severity, d.nodeId ?? "", d.edgeId ?? ""].join(" "),
  );

describe("validateScenarioGraph baseline (recorded before the lowered program)", () => {
  const actual = Object.fromEntries(
    corpus().map(([key, def]) => [key, render(def)]),
  );

  if (process.env.RECORD_BASELINE === "1") {
    writeFileSync(BASELINE, `${JSON.stringify(actual, null, 1)}\n`);
  }

  it("reports exactly the recorded diagnostics for every graph", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf-8")) as Record<
      string,
      string[]
    >;
    expect(Object.keys(actual)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(baseline)) {
      expect(actual[key], key).toEqual(baseline[key]);
    }
  });

  it("every shipped template and docs example is clean", () => {
    for (const [key, lines] of Object.entries(actual)) {
      if (key.startsWith("template:") || key.startsWith("example:")) {
        expect(lines, key).toEqual([]);
      }
    }
  });

  it("the corpus exercises every diagnostic code", () => {
    const seen = new Set(
      Object.values(actual).flatMap((lines) =>
        lines.map((l) => l.split(" ")[0]),
      ),
    );
    expect([...seen].sort()).toEqual(
      [
        "callAlreadyAnswered",
        "callLeftOpen",
        "danglingEdge",
        "duplicateHandle",
        "edgeIntoStart",
        "edgeOutOfEnd",
        "extraOutgoing",
        "missingStart",
        "multipleStart",
        "noCallHeld",
        "unpickableHandle",
        "unreachable",
      ].sort(),
    );
  });
});
