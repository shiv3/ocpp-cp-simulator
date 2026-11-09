import { describe, expect, it } from "vitest";

import {
  edgesByHandle,
  isTerminal,
  lowerScenario,
  nextStep,
  resolveOrigin,
  successors,
  type GraphEdgeLike,
} from "../scenarioGraph";

const node = (id: string, type = "delay", label?: string) => ({
  id,
  type,
  data: label === undefined ? {} : { label },
});
const edge = (
  source: string,
  target: string,
  sourceHandle?: string,
): GraphEdgeLike => ({
  id: `${source}>${target}${sourceHandle ? `:${sourceHandle}` : ""}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});
const ids = (edges: readonly GraphEdgeLike[]) => edges.map((e) => e.id);

describe("resolveOrigin / isTerminal", () => {
  it("takes the first node of type start or labelled Start, in file order", () => {
    expect(resolveOrigin({ nodes: [node("a"), node("s", "start")] })?.id).toBe(
      "s",
    );
    expect(
      resolveOrigin({
        nodes: [node("l", "delay", "Start"), node("s", "start")],
      })?.id,
    ).toBe("l");
    expect(resolveOrigin({ nodes: [node("a")] })).toBeUndefined();
  });

  it("ends a branch at type end or a node labelled End", () => {
    expect(isTerminal(node("e", "end"))).toBe(true);
    expect(isTerminal(node("l", "delay", "End"))).toBe(true);
    expect(isTerminal(node("a"))).toBe(false);
    expect(isTerminal({ id: "x" })).toBe(false);
  });
});

describe("lowerScenario", () => {
  it("indexes the first node of an id and reports what the executor ignores", () => {
    const first = node("d", "delay");
    const program = lowerScenario({
      nodes: [
        node("s", "start"),
        first,
        node("d", "end"),
        node("s2", "start"),
        node("e", "end"),
      ],
      edges: [edge("s", "d"), edge("d", "gone"), edge("e", "d")],
    });
    expect(program.nodesById.get("d")).toBe(first);
    expect(program.origin?.id).toBe("s");
    expect(program.starts.map((n) => n.id)).toEqual(["s", "s2"]);
    expect(ids(program.edgesFrom.get("d") ?? [])).toEqual(["d>gone"]);
    expect(program.outgoing.has("d")).toBe(false);
    expect(program.diagnostics.map((d) => d.code)).toEqual([
      "multipleStart",
      "danglingEdge",
      "edgeOutOfEnd",
    ]);
    expect(lowerScenario({ nodes: [], edges: [] }).diagnostics).toEqual([
      { code: "missingStart", severity: "error" },
    ]);
  });
});

describe("nextStep / successors", () => {
  const program = lowerScenario({
    nodes: [
      node("s", "start"),
      node("a"),
      node("b"),
      node("sw", "switch"),
      node("e", "end"),
      node("lost"),
    ],
    edges: [
      edge("s", "a"),
      edge("s", "sw"),
      edge("s", "gone"),
      edge("a", "gone"),
      edge("a", "b"),
      edge("a", "e"),
      edge("sw", "a", "case-0"),
      edge("sw", "b", "default"),
      edge("sw", "e", "default"),
      edge("e", "a"),
      edge("lost", "gone"),
    ],
  });
  const at = (id: string) => program.nodesById.get(id)!;

  it("runs every edge of the origin, terminal or not", () => {
    expect(ids(successors(program, at("s"), { asOrigin: true }))).toEqual([
      "s>a",
      "s>sw",
    ]);
    expect(ids(successors(program, at("e"), { asOrigin: true }))).toEqual([
      "e>a",
    ]);
  });

  it("leaves a step by its first edge to an existing node", () => {
    expect(nextStep(program, at("a"), null)).toMatchObject({
      kind: "edge",
      target: { id: "b" },
    });
    expect(ids(successors(program, at("a")))).toEqual(["a>b"]);
    expect(nextStep(program, at("b"), null)).toEqual({ kind: "noEdge" });
    expect(nextStep(program, at("lost"), null)).toEqual({
      kind: "missingTargets",
    });
    expect(nextStep(program, at("e"), null)).toEqual({ kind: "end" });
    expect(successors(program, at("e"))).toEqual([]);
  });

  it("leaves a switch along the picked handle, or any handle for analysis", () => {
    expect(ids(successors(program, at("sw"), { handle: "default" }))).toEqual([
      "sw>b:default",
    ]);
    expect(nextStep(program, at("sw"), "case-1")).toEqual({
      kind: "noEdgeForHandle",
      handle: "case-1",
    });
    expect(ids(successors(program, at("sw")))).toEqual([
      "sw>a:case-0",
      "sw>b:default",
      "sw>e:default",
    ]);
    const groups = edgesByHandle(program, at("sw"));
    expect([...groups.keys()]).toEqual(["case-0", "default"]);
    expect(ids(groups.get("default")!)).toEqual([
      "sw>b:default",
      "sw>e:default",
    ]);
  });
});
