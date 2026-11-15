/**
 * The Graph view's geometry, laid out recursively from the block tree
 * (`recognizeBlockTree`): a sequence is a column of cards; a branch point's
 * lanes stand side by side under it, each as wide as what it holds, under a
 * lane tag the curves end at (never cross); the lanes meet again at a merge
 * point below the tallest one; a loop is a tinted rectangle behind its body
 * with a solid return arc on its left; a jump is a dashed line routed
 * around the cards and lane tags it passes (out of the source's side, along
 * a channel beside them, across the gap row above the target and into its
 * top); steps nothing reaches stand in a column on the right. Pure (no React): the view draws what this returns.
 */
import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import { t } from "../../i18n";
import {
  editCapabilities,
  firstNodeOf,
  type Block,
  type BlockTree,
  type ForkBlock,
  type Lane,
  type LoopBlock,
  loopBlockBounds,
  type Seq,
  type SeqPath,
} from "./blockTree";
import {
  conditionText,
  isDeadLane,
  laneHandle,
  lanesLeavingLoop,
  stepNumbers,
} from "./stepTree";
import {
  NODE_W,
  NODE_H,
  LANE_W,
  ROW_H,
  GAP,
  START_R,
  END_R,
  CAP_GAP,
  EDIT_CAP_GAP,
  FORK_DROP,
  TAG_H,
  tagWidth,
  TAG_MARGIN,
  MERGE_DROP,
  LOOP_LEFT,
  LOOP_RIGHT,
  LOOP_TOP,
  LOOP_BOTTOM,
  LOOP_BUTTON_ROW,
  LOOP_TURN,
  LEAVING_GAP,
  PILL_ROOM,
  DETACHED_GAP,
  MARGIN_TOP,
  type Point,
  type GraphCard,
  type GraphPath,
  type GraphTag,
  type GraphLoop,
  type GraphPlus,
  type GraphPill,
  type TreeGraphGeometry,
  type Open,
  type Ctx,
  type TreeGraphOptions,
} from "./treeGraphLayout/geometry";
import { hasFork } from "./treeGraphLayout/helpers";
import { routeJumpLinks } from "./treeGraphLayout/links";

/** Lays the tree out. */
export function layoutTreeGraph(
  tree: BlockTree,
  { editable, phaseOf }: TreeGraphOptions,
): TreeGraphGeometry {
  const numbers = stepNumbers(tree);
  const num = (id: string) => numbers.get(id) ?? "";
  const travelled = (id: string | null) => {
    if (id === null) return false;
    const p = phaseOf(id);
    return p === "done" || p === "current";
  };
  const capGap = editable ? EDIT_CAP_GAP : CAP_GAP;
  const slotOk = (seq: Seq, index: number) =>
    editCapabilities(tree, { kind: "slot", path: seq.path, index }).insertStep
      .ok;

  const cards: GraphCard[] = [];
  const paths: GraphPath[] = [];
  const tags: GraphTag[] = [];
  const loops: GraphLoop[] = [];
  const ends: Array<Point & { lane: number }> = [];
  const merges: Point[] = [];
  const discs: GraphPlus[] = [];
  const zones: GraphPlus[] = [];
  const pills: GraphPill[] = [];
  const centres = new Map<SeqPath, number[]>();
  let right = 0;
  let bottom = 0;
  const grow = (x: number, y: number) => {
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };

  // ---- Measure: the width each sequence and block needs.

  const widthMemo = new Map<string, { w: number; out: number }>();
  /** `out`: the width of lanes standing outside the loop (top-level forks
   *  of a loop body). */
  const measureSeq = (seq: Seq, ctx: Ctx): { w: number; out: number } => {
    const key = `${seq.path}|${ctx.loopHeader}|${ctx.outsideX !== null}`;
    const memo = widthMemo.get(key);
    if (memo) return memo;
    let w = LANE_W;
    let out = 0;
    for (const block of seq.blocks) {
      const m = measureBlock(block, ctx);
      w = Math.max(w, m.w);
      out += m.out;
    }
    const result = { w, out };
    widthMemo.set(key, result);
    return result;
  };
  const inner = (ctx: Ctx): Ctx => ({ ...ctx, outsideX: null });
  /** A loop rectangle's width around a body `bodyW` wide: in the editor,
   *  room on the right for the "+ branch" pill of a branch point inside. */
  const loopRectW = (loop: LoopBlock, bodyW: number) =>
    LOOP_LEFT +
    bodyW +
    LOOP_RIGHT +
    (editable && hasFork(loop.body) ? PILL_ROOM : 0);
  /** A lane is as wide as what it holds, or its tag. */
  const laneWidth = (fork: ForkBlock, lane: Lane, ctx: Ctx) =>
    Math.max(
      measureSeq(lane.body, inner(ctx)).w,
      tagWidth(conditionText(lane.condition, fork)) + TAG_MARGIN,
    );
  const measureBlock = (block: Block, ctx: Ctx): { w: number; out: number } => {
    if (block.kind === "step") return { w: LANE_W, out: 0 };
    if (block.kind === "loop") {
      const body = measureSeq(block.body, {
        loopHeader: block.headerId,
        outsideX: 0,
        lane: ctx.lane,
      });
      return {
        w:
          loopRectW(block, body.w) +
          (body.out > 0 ? LEAVING_GAP + body.out : 0),
        out: 0,
      };
    }
    const leaving =
      ctx.outsideX !== null
        ? lanesLeavingLoop(block, ctx.loopHeader)
        : new Set<number>();
    let w = 0;
    let out = 0;
    block.lanes.forEach((lane, i) => {
      const lw = laneWidth(block, lane, ctx);
      if (leaving.has(i)) out += lw;
      else w += lw;
    });
    return { w: Math.max(w, LANE_W), out };
  };

  // ---- Place.

  const curve = (a: Point, b: Point): { d: string; mid: Point } => {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (a.x === b.x) return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, mid };
    return {
      d: `M ${a.x} ${a.y} C ${a.x} ${mid.y}, ${b.x} ${mid.y}, ${b.x} ${b.y}`,
      mid,
    };
  };
  const connect = (
    open: Open,
    to: Point,
    toId: string,
    edgeId: string | null,
    key: string,
  ) => {
    const c = curve(open, to);
    paths.push({
      key,
      ...c,
      ...(edgeId ? { edgeId } : {}),
      lane: open.lane,
      done:
        toId === "end" || toId === "merge" || toId === "tag"
          ? travelled(open.from) && phaseOf(open.from ?? "") === "done"
          : travelled(toId),
      to: toId,
    });
  };
  let pathSeq = 0;
  const pathKey = (a: string | null, b: string) =>
    `${a ?? "start"}->${b}#${pathSeq++}`;

  /** Lays `seq` out in the column [left, left + width) from `top`, entered
   *  by `entries`. Returns its bottom and the ends that fall through to a
   *  node outside it. */
  const layoutSeq = (
    seq: Seq,
    left: number,
    width: number,
    top: number,
    entries: Open[],
    ctx: Ctx,
    laneLabel?: string,
  ): { bottom: number; exits: Open[] } => {
    const cx = left + width / 2;
    let y = top;
    let pending = entries;
    const seqCentres: number[] = [];
    centres.set(seq.path, seqCentres);
    const exits: Open[] = [];
    seq.blocks.forEach((block, i) => {
      // Ends that fall through to a node after this sequence go on up.
      const at = firstNodeOf(block).id;
      const into = pending.filter((p) => p.to === undefined || p.to === at);
      exits.push(...pending.filter((p) => p.to !== undefined && p.to !== at));
      pending = into;
      if (editable && slotOk(seq, i) && (i > 0 || seq.path !== "root")) {
        const prevBottom = Math.max(top - GAP, ...pending.map((p) => p.y));
        zones.push({
          slot: { lane: seq.path, index: i },
          label:
            i === 0
              ? t("scenarioRun.tree.insertAtTop", { n: num(at) })
              : t("scenarioRun.insertBetween", {
                  from: num(firstNodeOf(seq.blocks[i - 1]).id),
                  to: num(at),
                }),
          x: cx,
          y: (prevBottom + y) / 2,
        });
      }
      const r = layoutBlock(block, seq, i, cx, left, width, y, pending, ctx);
      seqCentres.push(r.centre);
      // Ends falling through to the next block enter it; the next
      // iteration (or the end of the sequence) sorts them.
      pending = [...r.open, ...r.exits];
      y = r.bottom + GAP;
    });
    // Ends falling through to a node outside the sequence go on up.
    exits.push(...pending.filter((p) => p.to !== undefined));
    pending = pending.filter((p) => p.to === undefined);
    // How the sequence ends.
    const last = seq.blocks[seq.blocks.length - 1];
    let end = y - GAP;
    const lastBottom = seq.blocks.length > 0 ? end : top - GAP;
    const exit = seq.exit;
    const endAdd = editable && slotOk(seq, seq.blocks.length);
    const discAt = (y0: number) => {
      if (!endAdd) return;
      discs.push({
        slot: { lane: seq.path, index: seq.blocks.length },
        label:
          laneLabel !== undefined && seq.blocks.length === 0
            ? t("scenarioRun.addToBranch", { name: laneLabel })
            : last
              ? last.kind === "step"
                ? t("scenarioRun.addAfter", { n: num(last.node.id) })
                : t("scenarioRun.tree.addAfterBlock", {
                    n: num(firstNodeOf(last).id),
                  })
              : t("scenarioRun.addFirst"),
        x: cx,
        y: y0,
      });
    };
    if (
      exit.kind === "end" ||
      (exit.kind === "stop" && exit.reason === "noEdge")
    ) {
      const ringY = lastBottom + capGap + END_R;
      discAt(lastBottom + capGap / 2);
      for (const open of pending) {
        connect(
          open,
          { x: cx, y: ringY - END_R },
          "end",
          open.fixed
            ? open.edgeId
            : (open.edgeId ?? (exit.kind === "end" ? exit.edgeId : null)),
          pathKey(open.from, `end-${seq.path}`),
        );
      }
      ends.push({ x: cx, y: ringY, lane: ctx.lane });
      end = ringY + END_R;
    } else if (exit.kind === "fallthrough") {
      discAt(lastBottom + 14);
      for (const open of pending) {
        exits.push({
          ...open,
          edgeId: open.fixed
            ? open.edgeId
            : (open.edgeId ?? exit.edgeId ?? null),
          fixed: true,
          to: exit.to,
        });
      }
      end = Math.max(lastBottom, ...pending.map((p) => p.y));
      if (endAdd) end = Math.max(end, lastBottom + 24);
    } else {
      // A link (drawn later from the card), or a stop: nothing more here.
      discAt(lastBottom + 14);
      if (endAdd) end = Math.max(end, lastBottom + 24);
      // An empty lane that jumps: its tag's line ends at the jump.
      for (const open of pending) {
        if (exit.kind === "link") {
          linkStarts.set(exit.edgeId, { x: open.x, y: open.y });
        }
      }
    }
    grow(left + width, end);
    return { bottom: Math.max(end, lastBottom), exits };
  };

  /** Where an empty lane's jump starts (its tag), by edge id. */
  const linkStarts = new Map<string, Point>();

  const layoutBlock = (
    block: Block,
    seq: Seq,
    index: number,
    cx: number,
    left: number,
    width: number,
    y: number,
    pending: Open[],
    ctx: Ctx,
  ): { bottom: number; centre: number; open: Open[]; exits: Open[] } => {
    if (block.kind === "step") {
      placeCard(
        block.node,
        seq,
        index,
        cx,
        y,
        ctx,
        false,
        pending,
        block.edgeIn,
      );
      return {
        bottom: y + NODE_H,
        centre: y + NODE_H / 2,
        open: [
          {
            x: cx,
            y: y + NODE_H,
            edgeId: null,
            from: block.node.id,
            lane: ctx.lane,
          },
        ],
        exits: [],
      };
    }
    if (block.kind === "loop") {
      return layoutLoop(block, left, width, y, pending, ctx);
    }
    return layoutFork(block, seq, index, cx, left, width, y, pending, ctx);
  };

  const placeCard = (
    node: ScenarioNode,
    seq: Seq,
    index: number,
    cx: number,
    y: number,
    ctx: Ctx,
    isFork: boolean,
    pending: Open[],
    edgeIn: string | null,
  ) => {
    cards.push({
      node,
      x: cx,
      y,
      seqPath: seq.path,
      index,
      lane: ctx.lane,
      isFork,
    });
    for (const open of pending) {
      connect(
        open,
        { x: cx, y },
        node.id,
        open.fixed
          ? open.edgeId
          : (open.edgeId ?? (pending.length === 1 ? edgeIn : null)),
        pathKey(open.from, node.id),
      );
    }
    grow(cx + NODE_W / 2, y + NODE_H);
  };

  const layoutFork = (
    fork: ForkBlock,
    seq: Seq,
    index: number,
    cx: number,
    left: number,
    width: number,
    y: number,
    pending: Open[],
    ctx: Ctx,
  ): { bottom: number; centre: number; open: Open[]; exits: Open[] } => {
    const isStart = fork.forkKind === "start";
    let from: Point;
    let fromId: string | null;
    let centre: number;
    if (isStart) {
      // START's dot is the fork node.
      startDot = { x: cx, y: y + START_R };
      from = { x: cx, y: y + 2 * START_R };
      fromId = null;
      centre = y;
    } else {
      placeCard(fork.node, seq, index, cx, y, ctx, true, pending, fork.edgeIn);
      from = { x: cx, y: y + NODE_H };
      fromId = fork.node.id;
      centre = y + NODE_H / 2;
    }
    if (editable) {
      pills.push({
        nodeId: fork.node.id,
        x: isStart ? cx + 14 : cx + NODE_W / 2 + 10,
        y: isStart ? from.y - START_R - 11 : y + NODE_H / 2 - 11,
        label: isStart
          ? t("scenarioRun.addParallelBranch")
          : t("scenarioRun.tree.addLaneTo", { n: num(fork.node.id) }),
      });
    }
    // Lanes that leave the loop around: marked at any depth; only those
    // of a top-level fork of the loop's body stand outside its rectangle.
    const leavesLoop =
      ctx.loopHeader !== null
        ? lanesLeavingLoop(fork, ctx.loopHeader)
        : new Set<number>();
    const leaving = ctx.outsideX !== null ? leavesLoop : new Set<number>();
    const tagTop = (isStart ? from.y : y + NODE_H) + FORK_DROP;
    const bodyTop = tagTop + TAG_H + GAP;
    const laneWidths = fork.lanes.map((lane) => laneWidth(fork, lane, ctx));
    const staying = laneWidths.reduce(
      (sum, w, i) => (leaving.has(i) ? sum : sum + w),
      0,
    );
    let x = left + (width - staying) / 2;
    let outX = ctx.outsideX ?? 0;
    let lowest = bodyTop;
    const laneExits: Open[] = [];
    fork.lanes.forEach((lane, i) => {
      const lw = laneWidths[i];
      let laneLeft: number;
      if (leaving.has(i)) {
        laneLeft = outX;
        outX += lw;
      } else {
        laneLeft = x;
        x += lw;
      }
      const lx = laneLeft + lw / 2;
      const r = layoutLane(
        fork,
        lane,
        i,
        laneLeft,
        lw,
        lx,
        tagTop,
        bodyTop,
        from,
        fromId,
        leavesLoop.has(i),
        ctx,
      );
      lowest = Math.max(lowest, r.bottom);
      laneExits.push(...r.exits);
    });
    // Where the lanes meet again: a point below the lowest lane.
    const merge = fork.merge;
    const toMerge = merge ? laneExits.filter((e) => e.to === merge.nodeId) : [];
    const exits = laneExits.filter((e) => !toMerge.includes(e));
    if (merge && toMerge.length > 0 && merge.nodeId !== ctx.loopHeader) {
      const point = { x: cx, y: lowest + MERGE_DROP };
      merges.push(point);
      for (const open of toMerge) {
        connect(
          open,
          point,
          "merge",
          open.edgeId,
          pathKey(open.from, `merge-${fork.node.id}`),
        );
      }
      return {
        bottom: point.y,
        centre,
        open: [
          {
            x: cx,
            y: point.y,
            edgeId: null,
            fixed: true,
            // The merged path counts as travelled once a lane into it is.
            from: toMerge.find((e) => travelled(e.from))?.from ?? null,
            lane: ctx.lane,
          },
        ],
        exits,
      };
    }
    // Lanes meeting at the loop's header go back with the loop's arc.
    return {
      bottom: lowest,
      centre,
      open: [],
      exits: [...exits, ...toMerge],
    };
  };

  let startDot: Point | null = null;

  const layoutLane = (
    fork: ForkBlock,
    lane: Lane,
    i: number,
    laneLeft: number,
    lw: number,
    lx: number,
    tagTop: number,
    bodyTop: number,
    from: Point,
    fromId: string | null,
    leaves: boolean,
    ctx: Ctx,
  ): { bottom: number; exits: Open[] } => {
    const text = conditionText(lane.condition, fork);
    const count = countSteps(lane.body);
    tags.push({
      key: `${fork.node.id}:${i}`,
      forkId: fork.node.id,
      laneIndex: i,
      x: lx,
      y: tagTop,
      w: Math.min(tagWidth(text), lw - TAG_MARGIN),
      handle: laneHandle(lane.condition),
      text,
      dead: isDeadLane(lane),
      leaves,
      count,
    });
    // The fork's edge ends at the tag's top; the lane goes on from its
    // bottom. A curve never crosses the tag's text.
    const laneCtx: Ctx = {
      loopHeader: ctx.loopHeader,
      outsideX: null,
      lane: i,
    };
    paths.push({
      key: pathKey(fromId, `tag-${fork.node.id}-${i}`),
      ...curve(from, { x: lx, y: tagTop }),
      edgeId: lane.edgeId,
      lane: i,
      done: travelled(firstLaneNode(lane)),
      to: "tag",
    });
    const r = layoutSeq(
      lane.body,
      laneLeft,
      lw,
      bodyTop,
      [
        {
          x: lx,
          y: tagTop + TAG_H,
          edgeId: null,
          fixed: true,
          from: fromId,
          lane: i,
        },
      ],
      laneCtx,
      text,
    );
    return { bottom: Math.max(r.bottom, tagTop + TAG_H), exits: r.exits };
  };

  const firstLaneNode = (lane: Lane): string | null =>
    lane.body.blocks[0] ? firstNodeOf(lane.body.blocks[0]).id : null;

  const countSteps = (seq: Seq): number => {
    let n = 0;
    const visit = (s: Seq) => {
      for (const b of s.blocks) {
        if (b.kind === "step") n++;
        if (b.kind === "fork") {
          n++;
          b.lanes.forEach((l) => visit(l.body));
        }
        if (b.kind === "loop") visit(b.body);
      }
    };
    visit(seq);
    return n;
  };

  const layoutLoop = (
    loop: LoopBlock,
    left: number,
    width: number,
    y: number,
    pending: Open[],
    ctx: Ctx,
  ): { bottom: number; centre: number; open: Open[]; exits: Open[] } => {
    const bodyCtx: Ctx = {
      loopHeader: loop.headerId,
      outsideX: 0,
      lane: ctx.lane,
    };
    const body = measureSeq(loop.body, bodyCtx);
    const rectW = loopRectW(loop, body.w);
    const total = rectW + (body.out > 0 ? LEAVING_GAP + body.out : 0);
    const rectLeft = left + (width - total) / 2;
    bodyCtx.outsideX = rectLeft + rectW + LEAVING_GAP;
    const cardsBefore = cards.length;
    const r = layoutSeq(
      loop.body,
      rectLeft + LOOP_LEFT,
      body.w,
      y + LOOP_TOP,
      pending,
      bodyCtx,
    );
    const back = r.exits.filter((e) => e.to === loop.headerId);
    const onward = r.exits.filter((e) => e.to !== loop.headerId);
    // The rectangle covers the repeated part: the body's own column (lanes
    // standing outside it are not in it).
    const inside = cards
      .slice(cardsBefore)
      .filter((c) => c.x < rectLeft + rectW);
    const innerBottom = Math.max(
      y + LOOP_TOP + NODE_H,
      ...inside.map((c) => c.y + NODE_H),
      ...back.map((b) => b.y),
    );
    const rectBottom =
      innerBottom + LOOP_BOTTOM + (editable ? LOOP_BUTTON_ROW : 0);
    const header = cards.find((c) => c.node.id === loop.headerId);
    const channelX = rectLeft + 14;
    const arcs: GraphPath[] = back.map((b, k) => {
      const turnY = innerBottom + LOOP_TURN;
      const hy = (header?.y ?? y + LOOP_TOP) + NODE_H / 2;
      const hx = (header?.x ?? b.x) - NODE_W / 2;
      const rr = 8;
      const d = [
        `M ${b.x} ${b.y}`,
        `L ${b.x} ${turnY - rr}`,
        `Q ${b.x} ${turnY} ${b.x - rr} ${turnY}`,
        `L ${channelX + rr} ${turnY}`,
        `Q ${channelX} ${turnY} ${channelX} ${turnY - rr}`,
        `L ${channelX} ${hy + rr}`,
        `Q ${channelX} ${hy} ${channelX + rr} ${hy}`,
        `L ${hx - 2} ${hy}`,
      ].join(" ");
      return {
        key: `loop-${loop.headerId}-${k}`,
        d,
        ...(b.edgeId ? { edgeId: b.edgeId } : {}),
        lane: ctx.lane,
        done: travelled(b.from) && phaseOf(b.from ?? "") === "done",
        to: loop.headerId,
        mid: { x: channelX, y: (turnY + hy) / 2 },
      };
    });
    const ids = inside.map((c) => c.node.id);
    const repeated = ids
      .map((id) => numbers.get(id))
      .filter((n): n is number => n !== undefined);
    const from = numbers.get(loop.headerId) ?? 0;
    loops.push({
      key: loop.headerId,
      headerId: loop.headerId,
      rect: { x: rectLeft, y, w: rectW, h: rectBottom - y },
      arcs,
      label: {
        x: rectLeft + LOOP_LEFT,
        y: rectBottom - 22 - (editable ? LOOP_BUTTON_ROW : 0),
      },
      from,
      to: Math.max(from, ...repeated),
      canExit:
        onward.length > 0 ||
        inside.some((c) => c.isFork) ||
        loopBlockBounds(loop) !== null,
      loopEdge: loop.loopEdge,
      ids,
    });
    const centre = (header?.y ?? y) + NODE_H / 2;
    // A bounded loop goes on from its rectangle's bottom (its latch's
    // ordinary edge, once a bound fires).
    const latch = loop.loopEdge ? back[0]?.from : undefined;
    const open: Open[] =
      latch !== undefined
        ? [
            {
              x: header?.x ?? rectLeft + rectW / 2,
              y: rectBottom,
              edgeId: null,
              from: latch,
              lane: ctx.lane,
            },
          ]
        : [];
    // The loop's way on: ends that leave it go to what follows.
    return {
      bottom: Math.max(rectBottom, r.bottom),
      centre,
      open,
      exits: onward.map((o) => ({ ...o })),
    };
  };

  // Root: START, then the root sequence (a fan-out draws START as its
  // fork's node).
  const rootM = measureSeq(tree.root, {
    loopHeader: null,
    outsideX: null,
    lane: 0,
  });
  const rootW = rootM.w;
  const rootFork = tree.root.blocks[0];
  const startForks =
    rootFork?.kind === "fork" && rootFork.node.id === tree.origin?.id;
  const top = MARGIN_TOP + START_R + GAP;
  let rootEntries: Open[] = [];
  if (!startForks && tree.origin) {
    startDot = { x: rootW / 2, y: MARGIN_TOP };
    rootEntries = [
      {
        x: rootW / 2,
        y: MARGIN_TOP + START_R,
        edgeId: null,
        from: null,
        lane: 0,
      },
    ];
    if (editable) {
      pills.push({
        nodeId: tree.origin.id,
        x: rootW / 2 + 14,
        y: MARGIN_TOP - 11,
        label: t("scenarioRun.addParallelBranch"),
      });
    }
  }
  layoutSeq(tree.root, 0, rootW, startForks ? MARGIN_TOP : top, rootEntries, {
    loopHeader: null,
    outsideX: null,
    lane: 0,
  });

  // Steps nothing reaches: a column on the right.
  let detached: Point | null = null;
  if (tree.detached.length > 0) {
    const dLeft = right + DETACHED_GAP;
    detached = { x: dLeft, y: MARGIN_TOP - 8 };
    let dy = MARGIN_TOP + 26;
    for (const seq of tree.detached) {
      const m = measureSeq(seq, { loopHeader: null, outsideX: null, lane: 0 });
      const r = layoutSeq(seq, dLeft, m.w, dy, [], {
        loopHeader: null,
        outsideX: null,
        lane: 0,
      });
      dy = r.bottom + ROW_H;
    }
  }
  const { links, reach } = routeJumpLinks(tree, {
    cards,
    tags,
    ends,
    discs,
    merges,
    pills,
    startDot,
    linkStarts,
  });
  right = Math.max(right, reach);

  for (const pill of pills) right = Math.max(right, pill.x + 110);
  return {
    cards,
    paths,
    links,
    tags,
    loops,
    ends,
    merges,
    start: startDot,
    discs,
    zones,
    pills,
    detached,
    centres,
    width: Math.ceil(right + 8),
    height: Math.ceil(bottom + 16),
  };
}

/** The ids of the edges the Graph view draws: every edge the tree draws
 *  structurally and every jump between two placed steps (an edge back
 *  into START is not drawn: START has no card to go into). */
export function graphEdgeIds(tree: BlockTree): Set<string> {
  const ids = new Set<string>(tree.drawnEdges.keys());
  const placed = new Set<string>(tree.nodePath.keys());
  if (tree.origin) placed.delete(tree.origin.id);
  for (const link of tree.links) {
    if (placed.has(link.edge.source) && placed.has(link.edge.target)) {
      ids.add(link.edge.id);
    }
  }
  return ids;
}

export {
  END_R,
  GAP,
  LANE_W,
  NODE_H,
  NODE_W,
  ROW_H,
  START_R,
  TAG_H,
  TAG_MAX_W,
  tagWidth,
} from "./treeGraphLayout/geometry";
export type {
  GraphCard,
  GraphLink,
  GraphLoop,
  GraphPath,
  GraphPill,
  GraphPlus,
  GraphTag,
  Point,
  TreeGraphGeometry,
  TreeGraphOptions,
} from "./treeGraphLayout/geometry";
