/**
 * `validateScenarioGraph` must report exactly what it reported before it was
 * rebuilt on the lowered program (`scenarioGraph.ts`). The baseline in
 * `__fixtures__/validateScenarioGraph.baseline.json` was recorded from the
 * validator of #829, before it was touched, over: every shipped template,
 * every `docs/examples/scenarios/*.json`, and a seeded corpus of messy graphs
 * (`graphFuzz.ts`).
 *
 * Re-record (`RECORD_BASELINE=1`) only from code whose diagnostics are meant
 * to stay; a diff here is a behaviour change of the validator.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scenarioTemplates } from "../../utils/scenarioTemplates";
import { validateScenarioGraph } from "../scenarioConnectionRules";
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
        "edgeIntoStart",
        "edgeOutOfEnd",
        "extraOutgoing",
        "missingStart",
        "multipleStart",
        "noCallHeld",
        "unreachable",
      ].sort(),
    );
  });
});
