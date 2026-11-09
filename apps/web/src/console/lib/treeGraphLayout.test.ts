import { describe, expect, it } from "vitest";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { scenarioTemplates } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import { recognizeBlockTree } from "./blockTree";
import { treeSteps } from "./stepTree";
import {
  NODE_H,
  NODE_W,
  TAG_H,
  graphEdgeIds,
  layoutTreeGraph,
  type TreeGraphGeometry,
} from "./treeGraphLayout";
import { NESTED_FIXTURES, loopWithTwoExits } from "../test/treeFixtures";

const layout = (def: ScenarioDefinition, editable = true) =>
  layoutTreeGraph(recognizeBlockTree(def), {
    editable,
    phaseOf: () => "todo",
  });

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  name: string;
}

const cardRects = (g: TreeGraphGeometry): Rect[] =>
  g.cards.map((c) => ({
    x1: c.x - NODE_W / 2,
    y1: c.y,
    x2: c.x + NODE_W / 2,
    y2: c.y + NODE_H,
    name: `card ${c.node.id}`,
  }));
const tagRects = (g: TreeGraphGeometry): Rect[] =>
  g.tags.map((t) => ({
    x1: t.x - t.w / 2,
    y1: t.y,
    x2: t.x + t.w / 2,
    y2: t.y + TAG_H,
    name: `tag ${t.key}`,
  }));
const overlaps = (a: Rect, b: Rect) =>
  a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const inside = (p: { x: number; y: number }, r: Rect, pad = 1) =>
  p.x > r.x1 + pad && p.x < r.x2 - pad && p.y > r.y1 + pad && p.y < r.y2 - pad;

/** Points along a path of M / L / C / Q commands. */
function samples(d: string): Array<{ x: number; y: number }> {
  const tokens = d.match(/[MLCQ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: Array<{ x: number; y: number }> = [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") cur = { x: num(), y: num() };
    else if (cmd === "L") {
      const to = { x: num(), y: num() };
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        out.push({
          x: cur.x + (to.x - cur.x) * t,
          y: cur.y + (to.y - cur.y) * t,
        });
      }
      cur = to;
    } else if (cmd === "C" || cmd === "Q") {
      const pts = [cur];
      const n = cmd === "C" ? 3 : 2;
      for (let k = 0; k < n; k++) pts.push({ x: num(), y: num() });
      for (let k = 1; k < 40; k++) {
        const t = k / 40;
        let level = pts;
        while (level.length > 1) {
          level = level.slice(1).map((p, j) => ({
            x: level[j].x + (p.x - level[j].x) * t,
            y: level[j].y + (p.y - level[j].y) * t,
          }));
        }
        out.push(level[0]);
      }
      cur = pts[pts.length - 1];
    }
  }
  return out;
}

const shipped = scenarioTemplates.map(
  (t) => [t.id, t.createScenario("CP-1", 1)] as const,
);
const nested = Object.entries(NESTED_FIXTURES).map(
  ([name, make]) => [name, make()] as const,
);

describe("layoutTreeGraph", () => {
  it.each([...nested, ...shipped])(
    "%s: one card per step, every drawn edge drawn, nothing overlapping",
    (_name, def) => {
      const tree = recognizeBlockTree(def);
      const g = layout(def);
      expect(g.cards.map((c) => c.node.id).sort()).toEqual(
        treeSteps(tree)
          .map((s) => s.id)
          .sort(),
      );
      const drawn = new Set(
        [
          ...g.paths.map((p) => p.edgeId),
          ...g.loops.flatMap((l) => l.arcs.map((a) => a.edgeId)),
          ...g.links.map((l) => l.edgeId),
        ].filter((id): id is string => id !== undefined),
      );
      expect([...graphEdgeIds(tree)].filter((id) => !drawn.has(id))).toEqual(
        [],
      );
      // Cards and tags never overlap each other.
      const boxes = [...cardRects(g), ...tagRects(g)];
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          expect(
            overlaps(boxes[a], boxes[b]),
            `${boxes[a].name} / ${boxes[b].name}`,
          ).toBe(false);
        }
      }
      // No curve runs through a lane tag (the fork's curve ends at its top).
      const tags = tagRects(g);
      for (const path of [
        ...g.paths,
        ...g.loops.flatMap((l) => l.arcs),
        ...g.links,
      ]) {
        for (const p of samples(path.d)) {
          for (const tag of tags) {
            expect(inside(p, tag), `${path.key} through ${tag.name}`).toBe(
              false,
            );
          }
        }
      }
      // Everything fits the canvas.
      for (const box of boxes) {
        expect(box.x1).toBeGreaterThanOrEqual(0);
        expect(box.x2).toBeLessThanOrEqual(g.width);
        expect(box.y2).toBeLessThanOrEqual(g.height);
      }
    },
  );

  it("nested forks: a lane is as wide as what it holds, its fork centred over it", () => {
    const g = layout(NESTED_FIXTURES.switchInLane());
    const at = (id: string) => g.cards.find((c) => c.node.id === id)!;
    // inner's lanes stand under lane A, left of lane B.
    expect(at("x").x).toBeLessThan(at("inner").x);
    expect(at("y").x).toBeGreaterThan(at("inner").x);
    expect(at("y").x + NODE_W / 2).toBeLessThan(at("b").x - NODE_W / 2);
    expect(at("a").x).toBe(at("inner").x);
    expect(g.tags.map((t) => t.text)).toEqual([
      'case-0 → "Accepted"',
      'case-0 → "Charging"',
      "default",
      "default",
    ]);
  });

  it("a merge point sits below the lowest lane; the merge step below it", () => {
    const g = layout(NESTED_FIXTURES.ifElseReconverges());
    const at = (id: string) => g.cards.find((c) => c.node.id === id)!;
    expect(g.merges).toHaveLength(1);
    const m = g.merges[0];
    expect(m.y).toBeGreaterThan(Math.max(at("ok").y, at("ko").y) + NODE_H);
    expect(at("merge").y).toBeGreaterThan(m.y);
    expect(m.x).toBe(at("check").x);
    // Both lanes' last edges go into the merge point.
    expect(
      g.paths
        .filter((p) => p.key.includes("->merge-check"))
        .map((p) => p.edgeId),
    ).toEqual(["ok->merge", "ko->merge"]);
  });

  it("a loop: a rectangle around its body, a return arc into the header, the leaving lane outside", () => {
    const def = loopWithTwoExits();
    const g = layout(def);
    expect(g.loops).toHaveLength(1);
    const loop = g.loops[0];
    const r = loop.rect;
    const at = (id: string) => g.cards.find((c) => c.node.id === id)!;
    const within = (id: string) =>
      at(id).x - NODE_W / 2 >= r.x &&
      at(id).x + NODE_W / 2 <= r.x + r.w &&
      at(id).y >= r.y &&
      at(id).y + NODE_H <= r.y + r.h;
    expect(["head", "pick", "again"].every(within)).toBe(true);
    expect(within("bye")).toBe(false);
    expect(at("bye").x - NODE_W / 2).toBeGreaterThan(r.x + r.w);
    expect(g.tags.find((t) => t.key === "pick:2")?.leaves).toBe(true);
    // The loop's way on follows below it.
    expect(at("out").y).toBeGreaterThan(r.y + r.h);
    expect(loop.arcs.map((a) => a.edgeId)).toEqual(["again->head"]);
    expect(loop.canExit).toBe(true);
    expect([loop.from, loop.to]).toEqual([2, 4]);
  });

  it("a jump is a dashed curve swinging right of the cards it passes", () => {
    const def = NESTED_FIXTURES.switchInLane();
    def.edges = def.edges.map((e) =>
      e.id === "b->end" ? { ...e, id: "b->x", target: "x" } : e,
    );
    const g = layout(def);
    expect(g.links.map((l) => [l.edgeId, l.role])).toEqual([["b->x", "join"]]);
    const xs = samples(g.links[0].d).map((p) => p.x);
    const rightmost = Math.max(...g.cards.map((c) => c.x + NODE_W / 2));
    expect(Math.max(...xs)).toBeGreaterThan(rightmost - NODE_W / 2);
    expect(g.width).toBeGreaterThan(Math.max(...xs));
  });

  it("steps nothing reaches stand in a column on the right", () => {
    const g = layout(NESTED_FIXTURES.withDetached());
    const at = (id: string) => g.cards.find((c) => c.node.id === id)!;
    expect(g.detached).not.toBeNull();
    expect(at("i1").x).toBeGreaterThan(at("s1").x + NODE_W);
    expect(g.detached!.x).toBeLessThanOrEqual(at("i1").x - NODE_W / 2);
  });

  it("read-only: no + discs, zones or pills", () => {
    const g = layout(NESTED_FIXTURES.switchInLane(), false);
    expect(g.discs).toEqual([]);
    expect(g.zones).toEqual([]);
    expect(g.pills).toEqual([]);
  });

  it("insert slots carry the sequence path at any depth", () => {
    const g = layout(NESTED_FIXTURES.switchInLane());
    expect(g.discs.map((d) => `${d.slot.lane}@${d.slot.index}`)).toEqual(
      expect.arrayContaining([
        "root/0/lanes/0/1/lanes/0@1",
        "root/0/lanes/0/1/lanes/1@1",
        "root/0/lanes/1@1",
      ]),
    );
    expect(g.zones.map((z) => `${z.slot.lane}@${z.slot.index}`)).toEqual(
      expect.arrayContaining(["root/0/lanes/0@1", "root/0/lanes/0@0"]),
    );
  });
});
