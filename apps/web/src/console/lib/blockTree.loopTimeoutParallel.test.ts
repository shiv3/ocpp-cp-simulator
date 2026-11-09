/**
 * Bounded loop edges (schema 1.10) next to timeout edges (1.8) and parallel /
 * join forks (1.9): all three survive the block tree and a rebuild.
 */
import { describe, expect, it } from "vitest";

import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";

import {
  allSeqs,
  assertTreeCovers,
  rebuildFromTree,
  recognizeBlockTree,
  type LoopBlock,
} from "./blockTree";
import { end, graph, node, start } from "./__fixtures__/blockTreeKit";

const wait = (id: string) =>
  node(id, ScenarioNodeType.STATUS_TRIGGER, {
    label: "Wait",
    targetStatus: "Charging",
    timeout: 5,
  });

const extra = (
  def: ReturnType<typeof graph>,
  edges: Array<Record<string, unknown>>,
) => ({ ...def, edges: [...def.edges, ...edges] }) as typeof def;

const summary = (def: ReturnType<typeof graph>) =>
  def.edges
    .map((e) => JSON.stringify(e, Object.keys(e).sort()))
    .sort()
    .join("\n");

describe("loop edges with timeout lanes and parallel forks", () => {
  it("a bounded loop around a wait that has a timeout lane", () => {
    const def = extra(
      graph(
        [start(), node("a"), wait("w"), node("x"), node("late"), end()],
        [
          ["start", "a"],
          ["a", "w"],
          ["w", "x"],
          ["x", "end"],
          ["late", "end"],
        ],
      ),
      [
        { id: "t", source: "w", target: "late", kind: "timeout" },
        { id: "l", source: "x", target: "w", kind: "loop", loop: { times: 3 } },
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const loops = allSeqs(tree).flatMap((s) =>
      s.blocks.filter((b): b is LoopBlock => b.kind === "loop"),
    );
    expect(loops).toHaveLength(1);
    expect(loops[0].loopEdge?.loop).toEqual({ times: 3 });
    const out = rebuildFromTree(def, tree);
    expect(summary(out)).toEqual(summary(def));
    expect(
      validateScenarioGraph(out).filter((i) => i.severity !== "info"),
    ).toEqual([]);
  });

  it("each branch of a parallel keeps its own bounded loop", () => {
    const def = extra(
      graph(
        [
          start(),
          node("p", "parallel" as ScenarioNodeType),
          node("a"),
          node("b"),
          node("j", "join" as ScenarioNodeType, { label: "Join" }),
          node("after"),
          end(),
        ],
        [
          ["start", "p"],
          ["p", "a"],
          ["p", "b"],
          ["a", "j"],
          ["b", "j"],
          ["j", "after"],
          ["after", "end"],
        ],
      ),
      [
        {
          id: "la",
          source: "a",
          target: "a",
          kind: "loop",
          loop: { times: 2 },
        },
        {
          id: "lb",
          source: "b",
          target: "b",
          kind: "loop",
          loop: { times: 4 },
        },
      ],
    );
    const tree = recognizeBlockTree(def);
    assertTreeCovers(def, tree);
    const out = rebuildFromTree(def, tree);
    expect(summary(out)).toEqual(summary(def));
    expect(
      validateScenarioGraph(out).filter((i) => i.severity !== "info"),
    ).toEqual([]);
  });
});
