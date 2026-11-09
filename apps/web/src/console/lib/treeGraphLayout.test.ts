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
import {
  NESTED_FIXTURES,
  deepLeavingLane,
  forkInLoop,
  intoStartFanOut,
  joinIntoLeftLane,
  loopWithTwoExits,
} from "../test/treeFixtures";

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
      // A jump crosses no card and no tag: it leaves its source's side and
      // enters its target's top.
      const cardBoxes = cardRects(g);
      for (const link of g.links) {
        for (const p of samples(link.d)) {
          for (const box of [...cardBoxes, ...tags]) {
            expect(inside(p, box), `${link.key} through ${box.name}`).toBe(
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

  it("a jump is a dashed line routed beside the cards it passes", () => {
    const def = NESTED_FIXTURES.switchInLane();
    def.edges = def.edges.map((e) =>
      e.id === "b->end" ? { ...e, id: "b->x", target: "x" } : e,
    );
    const g = layout(def);
    expect(g.links.map((l) => [l.edgeId, l.role])).toEqual([["b->x", "join"]]);
    const xs = samples(g.links[0].d).map((p) => p.x);
    // Orthogonal, into x's top, and on the canvas.
    const pts = g.links[0].points;
    for (let k = 1; k < pts.length; k++) {
      expect(pts[k].x === pts[k - 1].x || pts[k].y === pts[k - 1].y).toBe(true);
    }
    const x = g.cards.find((c) => c.node.id === "x")!;
    expect(pts[pts.length - 1].y).toBe(x.y);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(g.width).toBeGreaterThan(Math.max(...xs));
  });

  it("a join into a lane on the left runs in the gap row above its target and enters it from the top", () => {
    const g = layout(joinIntoLeftLane());
    const link = g.links.find((l) => l.edgeId === "a1->x1")!;
    const x1 = g.cards.find((c) => c.node.id === "x1")!;
    const pts = link.points;
    // Orthogonal: every segment horizontal or vertical.
    for (let k = 1; k < pts.length; k++) {
      expect(
        pts[k].x === pts[k - 1].x || pts[k].y === pts[k - 1].y,
        JSON.stringify(pts),
      ).toBe(true);
    }
    const last = pts[pts.length - 1];
    const beforeLast = pts[pts.length - 2];
    // Down into x1's top edge, from the row gap above it.
    expect(last.y).toBe(x1.y);
    expect(beforeLast).toEqual({ x: last.x, y: x1.y - (76 - NODE_H) / 2 });
    expect(Math.abs(last.x - x1.x)).toBeLessThan(NODE_W / 2);
    expect(last.x).not.toBe(x1.x); // clear of the structural line in
    // Not through any card or tag (the generic check, spelled out).
    const boxes = [...cardRects(g), ...tagRects(g)];
    for (const p of samples(link.d)) {
      for (const box of boxes) expect(inside(p, box), box.name).toBe(false);
      // Nor through an END ring or a + disc.
      for (const e of [...g.ends, ...g.discs]) {
        expect(Math.hypot(p.x - e.x, p.y - e.y)).toBeGreaterThan(8);
      }
    }
    // It takes the corridor between the two lanes, not a detour round the
    // right of the canvas.
    const a1 = g.cards.find((c) => c.node.id === "a1")!;
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThanOrEqual(a1.x);
  });

  it("an edge back into a START that fans out is not counted as drawn", () => {
    const def = intoStartFanOut();
    const tree = recognizeBlockTree(def);
    expect(tree.links.map((l) => [l.edge.id, l.role])).toEqual([
      ["q->start", "intoStart"],
    ]);
    expect(graphEdgeIds(tree).has("q->start")).toBe(false);
    expect(layout(def).links).toEqual([]);
  });

  it("a lane leaving the loop deeper down still carries the exit mark", () => {
    const g = layout(deepLeavingLane());
    const leaves = Object.fromEntries(g.tags.map((t) => [t.key, t.leaves]));
    // f2's default lane (bye → END) leaves; f2's case-0 and f1's lanes into
    // f2 or back to head do not.
    expect(leaves["f2:1"]).toBe(true);
    expect(leaves["f2:0"]).toBe(false);
    expect(leaves["f1:1"]).toBe(false);
  });

  it("a branch point's '+ branch' pill inside a loop stays inside the loop's rectangle", () => {
    let checked = 0;
    for (const def of [forkInLoop(), loopWithTwoExits(), deepLeavingLane()]) {
      const g = layout(def);
      for (const loop of g.loops) {
        const r = loop.rect;
        for (const pill of g.pills) {
          if (!loop.ids.includes(pill.nodeId)) continue;
          checked++;
          // The pill is about 70 px wide ("+ branch").
          expect(pill.x + 72, `${def.id} ${pill.nodeId}`).toBeLessThanOrEqual(
            r.x + r.w,
          );
        }
      }
      // Read-only: no pills, no extra room.
      const ro = layout(def, false);
      expect(ro.loops[0].rect.w).toBeLessThan(g.loops[0].rect.w);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
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
