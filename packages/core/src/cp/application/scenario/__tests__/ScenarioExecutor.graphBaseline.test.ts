/**
 * The executor must walk any graph exactly as it did before it took origin
 * resolution, terminal detection and next-edge selection from the lowered
 * program (`packages/core/src/scenario/scenarioGraph.ts`). The baseline in
 * `__fixtures__/executorGraphTraces.baseline.json` was recorded from the
 * executor before that change: for each seeded graph (`graphFuzz.ts`), a
 * fresh run and a resumed run, each traced as the nodes it executed, every
 * `log` callback, every `console.warn` and the error it ended with. Only a
 * hash and the length of each trace are stored; the coverage test below
 * checks that the corpus reaches every path the change touched. The full
 * traces of the first {@link READABLE_GRAPHS} graphs are also kept, in
 * `__fixtures__/executorGraphTraces.readable.json`, so that a change of walk
 * shows up as a diff a reviewer can read; each one hashes to its entry in the
 * baseline, so they are the traces recorded before the change too.
 *
 * Re-record (`RECORD_BASELINE=1`) only from code whose walk is meant to stay.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioDefinition } from "../ScenarioTypes";
import {
  fuzzGraphs,
  seededRandom,
  type FuzzGraph,
  type FuzzOptions,
} from "../../../../scenario/__tests__/graphFuzz";

const BASELINE = fileURLToPath(
  new URL("./__fixtures__/executorGraphTraces.baseline.json", import.meta.url),
);
const READABLE = fileURLToPath(
  new URL("./__fixtures__/executorGraphTraces.readable.json", import.meta.url),
);
/** How many graphs (fresh and resumed run each) keep their full trace. */
const READABLE_GRAPHS = 20;

/** Node types that finish at once without callbacks or timers. */
const fuzzOptions: FuzzOptions = {
  types: ["setState", "switch", "choice", "bogus"],
  dataFor: (type, rand) => {
    switch (type) {
      case "setState":
        return { key: "k", value: 1 };
      case "switch":
        return { value: Math.floor(rand() * 3), cases: [0, 1] };
      case "choice":
        return { options: [{ label: "x" }, { weight: 2 }] };
      default:
        return {};
    }
  },
};

/** A loop runs until this many nodes executed, then the run is stopped. */
const MAX_NODES = 25;

const asScenario = (graph: FuzzGraph, index: number): ScenarioDefinition =>
  ({
    id: `fuzz-${index}`,
    name: `fuzz-${index}`,
    targetType: "connector",
    targetId: 1,
    nodes: graph.nodes,
    edges: graph.edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  }) as unknown as ScenarioDefinition;

async function trace(
  scenario: ScenarioDefinition,
  resumeFromNodeId: string | undefined,
): Promise<string[]> {
  const lines: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      lines.push(`warn ${args.map(String).join(" ")}`);
    });
  let draws = 0;
  let executed = 0;
  const executor = new ScenarioExecutor(
    scenario,
    {
      log: (message, level) => lines.push(`log ${level} ${message}`),
      onNodeExecute: (nodeId) => {
        lines.push(`node ${nodeId}`);
        executed += 1;
        if (executed >= MAX_NODES) executor.stop();
      },
      onError: (error) => lines.push(`error ${error.message}`),
    },
    undefined,
    {
      rng: {
        next: () => [0.1, 0.9, 0.5][draws++ % 3]!,
        int: (min: number) => min,
        pick: <T>(items: readonly T[]) => items[0]!,
      } as never,
    },
  );
  try {
    await executor.start(
      resumeFromNodeId === undefined ? undefined : { resumeFromNodeId },
    );
  } catch (error) {
    lines.push(`threw ${(error as Error).message}`);
  } finally {
    warn.mockRestore();
  }
  return lines;
}

async function corpusTraces(): Promise<Record<string, string[]>> {
  const graphs = [
    ...fuzzGraphs(300, 566, fuzzOptions),
    ...fuzzGraphs(60, 567, { ...fuzzOptions, duplicateIds: true }),
  ];
  const rand = seededRandom(654);
  const out: Record<string, string[]> = {};
  for (const [index, graph] of graphs.entries()) {
    const scenario = asScenario(graph, index);
    out[`${index}:fresh`] = await trace(scenario, undefined);
    const resumeAt =
      rand() < 0.15
        ? "missing-node"
        : graph.nodes[Math.floor(rand() * graph.nodes.length)]!.id;
    out[`${index}:resume:${resumeAt}`] = await trace(scenario, resumeAt);
  }
  return out;
}

const digest = (lines: string[]): string =>
  `${lines.length}:${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)}`;

describe("ScenarioExecutor walk baseline (recorded before the lowered program)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("walks every graph exactly as recorded", async () => {
    const traces = await corpusTraces();
    const actual = Object.fromEntries(
      Object.entries(traces).map(([key, lines]) => [key, digest(lines)]),
    );
    const readable = Object.fromEntries(
      Object.entries(traces).filter(
        ([key]) => Number(key.split(":")[0]) < READABLE_GRAPHS,
      ),
    );
    if (process.env.RECORD_BASELINE === "1") {
      writeFileSync(BASELINE, `${JSON.stringify(actual, null, 1)}\n`);
      writeFileSync(READABLE, `${JSON.stringify(readable, null, 1)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf-8")) as Record<
      string,
      string
    >;
    expect(Object.keys(actual)).toEqual(Object.keys(baseline));
    // The readable traces first: their diff says what changed.
    const recorded = JSON.parse(readFileSync(READABLE, "utf-8")) as Record<
      string,
      string[]
    >;
    expect(Object.keys(readable)).toEqual(Object.keys(recorded));
    for (const [key, lines] of Object.entries(recorded)) {
      expect(digest(lines), `${key} (readable vs baseline)`).toBe(
        baseline[key],
      );
      expect(readable[key], key).toEqual(lines);
    }
    for (const key of Object.keys(baseline)) {
      expect(actual[key], key).toBe(baseline[key]);
    }

    // The corpus reaches every path origin resolution, terminal detection
    // and next-edge selection can take.
    const all = Object.values(traces).flat().join("\n");
    for (const fragment of [
      "No start node found in scenario",
      "Executing single branch",
      "parallel branches completed",
      "No nodes after Start",
      "No nodes after Resume point",
      "Resuming scenario from node",
      "Cannot resume",
      "which has no edge; the branch ends",
      "point to non-existent nodes",
      "Unknown node type: bogus",
      "Switch on",
      "Choice →",
    ]) {
      expect(all, fragment).toContain(fragment);
    }
  }, 60_000);
});
