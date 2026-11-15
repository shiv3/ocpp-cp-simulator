import { type BlockTree } from "../blockTree";
import {
  NODE_W,
  NODE_H,
  GAP,
  START_R,
  END_R,
  TAG_H,
  LINK_SWING,
  LINK_STEP,
  LINK_INSET,
  type Point,
  type GraphCard,
  type GraphLink,
  type GraphTag,
  type GraphPlus,
  type GraphPill,
} from "./geometry";
import { dedupe, roundedPath } from "./helpers";

export interface JumpLinkInputs {
  cards: readonly GraphCard[];
  tags: readonly GraphTag[];
  ends: ReadonlyArray<Point & { lane: number }>;
  discs: readonly GraphPlus[];
  merges: readonly Point[];
  pills: readonly GraphPill[];
  startDot: Point | null;
  linkStarts: ReadonlyMap<string, Point>;
}

/** The jump links of a laid-out tree, and how far right their channels reach. */
export function routeJumpLinks(
  tree: BlockTree,
  {
    cards,
    tags,
    ends,
    discs,
    merges,
    pills,
    startDot,
    linkStarts,
  }: JumpLinkInputs,
): { links: GraphLink[]; reach: number } {
  let reach = 0;

  // Jumps: dashed orthogonal routes. Out of the source card's side (an
  // empty lane: its tag), along a vertical channel (beside everything
  // between the two rows, or in the corridor between two columns), across
  // the gap row above the target and down into its top corner on the
  // channel's side. Of the channels tried, the one that crosses no card or
  // tag, keeps clear of END rings, `+` discs, merge points and pills, and is
  // shortest wins. Channels are stepped so two jumps never share a line.
  const links: GraphLink[] = [];
  const cardOf = new Map(cards.map((c) => [c.node.id, c]));
  interface Box {
    l: number;
    r: number;
    t: number;
    b: number;
    id?: string;
  }
  const hard: Box[] = [
    ...cards.map((c) => ({
      l: c.x - NODE_W / 2,
      r: c.x + NODE_W / 2,
      t: c.y,
      b: c.y + NODE_H,
      id: c.node.id,
    })),
    ...tags.map((tg) => ({
      l: tg.x - tg.w / 2,
      r: tg.x + tg.w / 2,
      t: tg.y,
      b: tg.y + TAG_H,
    })),
  ];
  const around = (p: Point, r: number): Box => ({
    l: p.x - r,
    r: p.x + r,
    t: p.y - r,
    b: p.y + r,
  });
  const soft: Box[] = [
    ...ends.map((e) => around(e, END_R + 2)),
    ...discs.map((d) => around(d, 11)),
    ...merges.map((m) => around(m, 5)),
    ...(startDot ? [around(startDot, START_R + 2)] : []),
    ...pills.map((pl) => ({ l: pl.x, r: pl.x + 72, t: pl.y, b: pl.y + 22 })),
  ];
  /** Boxes a polyline's segments cross (touching an edge is not), each
   *  grown by `pad` (never the jump's own source and target cards). */
  const crossings = (
    pts: Point[],
    boxes: readonly Box[],
    pad = 0,
    skip: ReadonlySet<string> = new Set(),
  ): number => {
    let n = 0;
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1];
      const q = pts[k];
      for (const o of boxes) {
        const g = o.id !== undefined && skip.has(o.id) ? 0 : pad;
        if (
          Math.max(p.x, q.x) > o.l - g + 1 &&
          Math.min(p.x, q.x) < o.r + g - 1 &&
          Math.max(p.y, q.y) > o.t - g + 1 &&
          Math.min(p.y, q.y) < o.b + g - 1
        ) {
          n++;
        }
      }
    }
    return n;
  };
  const length = (pts: Point[]) =>
    pts.reduce(
      (sum, q, k) =>
        k === 0
          ? 0
          : sum + Math.abs(q.x - pts[k - 1].x) + Math.abs(q.y - pts[k - 1].y),
      0,
    );
  const swings: Array<{ top: number; bottom: number; x: number }> = [];
  for (const link of tree.links) {
    const edge = link.edge;
    const to = cardOf.get(edge.target);
    const fromCard = cardOf.get(edge.source);
    const start = linkStarts.get(edge.id);
    if (!to || (!fromCard && !start)) continue;
    const gapY = to.y - GAP / 2;
    const srcX = fromCard ? fromCard.x : start!.x;
    const srcY = fromCard ? fromCard.y + NODE_H / 2 : start!.y + 6;
    const y1 = Math.min(srcY, gapY);
    const y2 = Math.max(srcY, gapY);
    const ends2 = new Set([edge.source, edge.target]);
    /** One orthogonal route: out of the source's side at `srcY`, (when
     *  `exitRow` differs, a short step out and along that row first), up or
     *  down `channel`, across `entryRow`, down into the target's top. */
    const route = (
      channel: number,
      exitRow: number = srcY,
      entryRow: number = gapY,
    ) => {
      let swing = channel;
      const lo = Math.min(y1, exitRow, entryRow);
      const hi = Math.max(y2, exitRow, entryRow);
      for (const sw of swings) {
        if (
          sw.top <= hi &&
          sw.bottom >= lo &&
          Math.abs(sw.x - swing) < LINK_STEP
        ) {
          swing = sw.x + (swing >= srcX ? LINK_STEP : -LINK_STEP);
        }
      }
      const out = swing >= srcX ? 1 : -1;
      const a = fromCard
        ? { x: srcX + (out * NODE_W) / 2, y: srcY }
        : { x: srcX, y: srcY };
      const tx = to.x + (swing >= to.x ? 1 : -1) * (NODE_W / 2 - LINK_INSET);
      const lead =
        exitRow === srcY
          ? [a]
          : [
              a,
              { x: a.x + out * 8, y: srcY },
              { x: a.x + out * 8, y: exitRow },
            ];
      const pts = dedupe([
        ...lead,
        { x: swing, y: exitRow },
        { x: swing, y: entryRow },
        { x: tx, y: entryRow },
        { x: tx, y: to.y },
      ]);
      const score =
        crossings(pts, hard) * 1e6 +
        crossings(pts, soft) * 1e4 +
        crossings(pts, hard, 6, ends2) * 1e3 +
        length(pts);
      return { pts, swing, score, curve: false };
    };
    const passed = hard.filter((o) => o.b >= y1 && o.t <= y2);
    const channels = new Set<number>([
      Math.max(srcX + NODE_W / 2, to.x, ...passed.map((o) => o.r)) + LINK_SWING,
      Math.min(srcX - NODE_W / 2, to.x, ...passed.map((o) => o.l)) - LINK_SWING,
      ...passed.flatMap((o) => [o.r + 12, o.l - 12]),
    ]);
    const pick = (opts: ReturnType<typeof route>[]) =>
      opts.reduce((m, o) => (o.score < m.score ? o : m));
    let best = pick(
      [...channels].map((c) => route(c)).filter((o) => o.swing >= 4),
    );
    if (best.score >= 1e6) {
      // Every plain route crosses a card: also leave along the source's own
      // gap rows, and enter along the free rows above the target.
      const exitRows = fromCard
        ? [fromCard.y - GAP / 2, fromCard.y + NODE_H + GAP / 2]
        : [];
      const above = cards
        .filter((c) => c.node.id !== edge.target && Math.abs(c.x - to.x) < 1)
        .filter((c) => c.y + NODE_H <= to.y)
        .sort((p, q) => q.y - p.y);
      const entryRows = [to.y - 6, to.y - GAP / 2 - 6].filter(
        (y) => y !== gapY,
      );
      let prevTop = to.y;
      for (const c of above.slice(0, 3)) {
        entryRows.push((c.y + NODE_H + prevTop) / 2);
        prevTop = c.y;
      }
      const more: ReturnType<typeof route>[] = [];
      const rows: Array<[number, number]> = [
        ...exitRows.map((r): [number, number] => [r, gapY]),
        ...entryRows.map((r): [number, number] => [srcY, r]),
        ...exitRows.flatMap((r) =>
          entryRows.map((e): [number, number] => [r, e]),
        ),
      ];
      for (const [r, e] of rows) {
        for (const c of channels) {
          if (c >= 4) more.push(route(c, r, e));
        }
      }
      if (more.length > 0) {
        const alt = pick(more);
        if (alt.score < best.score) best = alt;
      }
    }
    if (best.score >= 1e6) {
      // No clean route: the dashed curve beside everything (it may cross).
      const swingR = Math.max(...channels);
      const r = route(swingR);
      const a = fromCard
        ? { x: srcX + NODE_W / 2, y: srcY }
        : { x: srcX, y: srcY };
      const b = { x: to.x + NODE_W / 2 + 3, y: to.y + NODE_H / 2 };
      const p1 = { x: r.swing, y: a.y };
      const p2 = { x: r.swing, y: b.y };
      best = {
        ...r,
        pts: [a, p1, p2, b],
        curve: true,
      };
    }
    swings.push({ top: y1, bottom: y2, x: best.swing });
    reach = Math.max(reach, best.swing + 8);
    links.push({
      key: edge.id,
      d: best.curve
        ? `M ${best.pts[0].x} ${best.pts[0].y} C ${best.pts[1].x} ${best.pts[1].y}, ${best.pts[2].x} ${best.pts[2].y}, ${best.pts[3].x} ${best.pts[3].y}`
        : roundedPath(best.pts),
      points: best.pts,
      fallback: best.curve,
      edgeId: edge.id,
      from: edge.source,
      to: edge.target,
      role: link.role,
      lane: fromCard?.lane ?? 0,
      mid: { x: best.swing, y: (y1 + y2) / 2 },
    });
  }
  return { links, reach };
}
