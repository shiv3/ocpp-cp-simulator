/**
 * What the Steps and Graph views read off a {@link BlockTree}: the steps in
 * display order and their numbers, how a lane ends, which lanes of a fork
 * inside a loop leave it, and a lane's condition as a chip text. Pure: the
 * views and the editor share it.
 */
import {
  type ChoiceNodeData,
  type ScenarioNode,
  ScenarioNodeType,
  type SwitchNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import {
  describeMatcher,
  isMatcher,
} from "@ocpp-cp-simulator/core/scenario/valueMatch";

import { t } from "../../i18n";
import {
  loopBlockBounds,
  treeNodes,
  type BlockTree,
  type ForkBlock,
  type Lane,
  type LaneCondition,
  type LinkEdge,
  type LoopBlock,
  type LoopBoundsInput,
  type Seq,
} from "./blockTree";

/** The views draw a tree from a START; without one the editor lists an
 *  outline instead. */
export function isDrawableTree(tree: BlockTree): boolean {
  return tree.origin?.type === ScenarioNodeType.START;
}

/** Every step the views draw, in tree pre-order (fork nodes included, the
 *  START a run begins with left out): the order the boxes are numbered in. */
export function treeSteps(tree: BlockTree): ScenarioNode[] {
  const origin = tree.origin?.id;
  return treeNodes(tree).filter(
    (n) => n.id !== origin && n.type !== ScenarioNodeType.START,
  );
}

/** The 1-based number each step's box shows, by node id. */
export function stepNumbers(tree: BlockTree): ReadonlyMap<string, number> {
  return new Map(treeSteps(tree).map((n, i) => [n.id, i + 1]));
}

/** The link an edge is kept as, or undefined when it is drawn. */
export function linkOf(tree: BlockTree, edgeId: string): LinkEdge | undefined {
  return tree.links.find((l) => l.edge.id === edgeId);
}

/** Whether a run in `seq` can go on to `nodeId` by falling through (at the
 *  end of `seq` or of any lane nested in it). */
export function fallsThroughTo(seq: Seq, nodeId: string): boolean {
  if (seq.exit.kind === "fallthrough" && seq.exit.to === nodeId) return true;
  return seq.blocks.some((b) =>
    b.kind === "fork"
      ? b.lanes.some((l) => fallsThroughTo(l.body, nodeId))
      : b.kind === "loop"
        ? fallsThroughTo(b.body, nodeId)
        : false,
  );
}

/**
 * The lanes of `fork` (a block inside the body of the loop whose first step
 * is `headerId`) that leave the loop: they never come back to its header,
 * directly or through the fork's merge. Their steps run once, after the
 * loop is left, so the views draw them outside the loop (blockTree.ts,
 * deviation "a loop's exits other than the first").
 */
export function lanesLeavingLoop(
  fork: ForkBlock,
  headerId: string | null,
): Set<number> {
  const out = new Set<number>();
  if (headerId === null || fork.merge !== null) return out;
  fork.lanes.forEach((lane, i) => {
    if (!fallsThroughTo(lane.body, headerId)) out.add(i);
  });
  // Every lane leaving: the fork is the loop's way out as a whole; nothing
  // of it repeats, and there is nothing to split.
  if (out.size === fork.lanes.length) out.clear();
  return out;
}

/** Edges the executor never takes (drawn muted). */
export function isDeadLane(lane: Pick<Lane, "condition">): boolean {
  return (
    lane.condition.kind === "ignored" || lane.condition.kind === "unpickable"
  );
}

/** A switch value as it reads on a chip: `$from: call.idTag`, `"a"`, `3`;
 *  a `$match` case as `in Blocked|Invalid`, `≥ 80`, `missing`. */
export function formatValue(value: unknown): string {
  if (isMatcher(value)) return describeMatcher(value);
  if (value && typeof value === "object" && "$from" in value) {
    return `$from: ${String((value as { $from: unknown }).$from)}`;
  }
  if (value === undefined) return "?";
  return JSON.stringify(value) ?? String(value);
}

/** A lane's condition chip: `case-0 → "Accepted"`, `default`,
 *  `option-1 · 30% · "slow"`, `all run`, `ignored`, `unpickable: case-7`. */
export function conditionText(
  condition: LaneCondition,
  fork?: ForkBlock,
): string {
  switch (condition.kind) {
    case "case":
      return `case-${condition.index} → ${formatValue(condition.value)}`;
    case "default":
      return "default";
    case "option": {
      const options =
        fork?.node.type === ScenarioNodeType.CHOICE
          ? ((fork.node.data as Partial<ChoiceNodeData>).options ?? [])
          : [];
      const total = options.reduce(
        (sum, o) => sum + (typeof o?.weight === "number" ? o.weight : 1),
        0,
      );
      const share =
        total > 0 ? `${Math.round((condition.weight / total) * 100)}%` : null;
      return [
        `option-${condition.index}`,
        share,
        condition.label !== undefined ? JSON.stringify(condition.label) : null,
      ]
        .filter((part) => part !== null)
        .join(" · ");
    }
    case "all":
      return t("scenarioRun.tree.lane.all");
    case "first":
      return t("scenarioRun.tree.lane.first");
    case "event":
      return t("scenarioRun.tree.lane.event");
    case "timeout":
      return t("scenarioRun.tree.lane.timeout", { seconds: condition.seconds });
    case "ignored":
      return t("scenarioRun.tree.lane.ignored");
    case "unpickable":
      return t("scenarioRun.tree.lane.unpickable", {
        handle: condition.handle ?? t("scenarioRun.tree.lane.noHandle"),
      });
  }
}

/** A fork's header: "Switch on $from: call.idTag", "Choice",
 *  "Start: all run", "Only the first runs", "On timeout", "Parallel". */
export function forkSummary(fork: ForkBlock): string {
  switch (fork.forkKind) {
    case "switch": {
      const data = fork.node.data as Partial<SwitchNodeData>;
      return t("scenarioRun.tree.fork.switch", {
        value: formatValue(data.value),
      });
    }
    case "choice":
      return t("scenarioRun.tree.fork.choice");
    case "start":
      return t("scenarioRun.tree.fork.start");
    case "parallel":
      return t("scenarioRun.tree.fork.parallel");
    case "timeout":
      return t("scenarioRun.tree.fork.timeout");
    case "extra":
      return t("scenarioRun.tree.fork.extra");
  }
}

/** The branches a scenario has: the lanes that run, of every branch point
 *  that picks or fans out (a step's edges it never follows are none). */
export function branchCount(tree: BlockTree): number {
  let count = 0;
  const visit = (seq: Seq) => {
    for (const block of seq.blocks) {
      if (block.kind === "fork") {
        if (block.forkKind !== "extra") {
          count += block.lanes.filter((l) => !isDeadLane(l)).length;
        }
        block.lanes.forEach((l) => visit(l.body));
      }
      if (block.kind === "loop") visit(block.body);
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return count;
}

/** A number of seconds as `2 h`, `1 h 30 min`, `45 s`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts = [
    h > 0 ? t("scenarioRun.duration.h", { n: h }) : null,
    m > 0 ? t("scenarioRun.duration.m", { n: m }) : null,
    sec > 0 || total === 0 ? t("scenarioRun.duration.s", { n: sec }) : null,
  ];
  return parts.filter((p) => p !== null).join(" ");
}

/** What a loop's header says, piece by piece (the views draw the `until`
 *  cases as chips). */
export type LoopSummary =
  | { kind: "forever" }
  | { kind: "invalid"; problem: string }
  | {
      kind: "bounded";
      /** "3 times", "for 2 h": the bounds other than `until`, in order. */
      parts: string[];
      until: { value: string; cases: string[] } | null;
      /** More than one bound: the first one met exits. */
      several: boolean;
    };

/** The summary of `loop`'s bounds: "Repeat 3 times / for 2 h / until
 *  <value> is <cases> (whichever first)", or "Repeat forever". */
export function loopSummary(loop: Pick<LoopBlock, "loopEdge">): LoopSummary {
  const bounds = loopBlockBounds(loop);
  if (bounds === null) return { kind: "forever" };
  if ("problem" in bounds) return { kind: "invalid", problem: bounds.problem };
  const parts: string[] = [];
  if (bounds.times !== undefined) {
    parts.push(t("scenarioRun.loopBounds.times", { count: bounds.times }));
  }
  if (bounds.forSeconds !== undefined) {
    parts.push(
      t("scenarioRun.loopBounds.for", {
        duration: formatDuration(bounds.forSeconds),
      }),
    );
  }
  const until = bounds.until
    ? {
        value: formatValue(bounds.until.value),
        cases: bounds.until.cases.map(formatValue),
      }
    : null;
  return {
    kind: "bounded",
    parts,
    until,
    several: parts.length + (until ? 1 : 0) > 1,
  };
}

/** {@link loopSummary} as one line of text (a title, an aria label). */
export function loopSummaryText(loop: Pick<LoopBlock, "loopEdge">): string {
  const s = loopSummary(loop);
  if (s.kind === "forever") return t("scenarioRun.loopForever");
  if (s.kind === "invalid") {
    return t("scenarioRun.loopBounds.invalid", { problem: s.problem });
  }
  const pieces = [...s.parts];
  if (s.until) {
    pieces.push(
      t("scenarioRun.loopBounds.until", {
        value: s.until.value,
        cases: s.until.cases.join(t("scenarioRun.loopBounds.casesOr")),
      }),
    );
  }
  const text = t("scenarioRun.loopBounds.repeat", {
    bounds: pieces.join(t("scenarioRun.loopBounds.separator")),
  });
  return s.several
    ? `${text} ${t("scenarioRun.loopBounds.whicheverFirst")}`
    : text;
}

/** The loop's bounds as the editor's form edits them (malformed ones:
 *  none). */
export function loopBoundsInput(
  loop: Pick<LoopBlock, "loopEdge">,
): LoopBoundsInput {
  const bounds = loopBlockBounds(loop);
  if (bounds === null || "problem" in bounds) return {};
  return {
    ...(bounds.times !== undefined ? { times: bounds.times } : {}),
    ...(bounds.forSeconds !== undefined
      ? { forSeconds: bounds.forSeconds }
      : {}),
    ...(bounds.until
      ? {
          until: { value: bounds.until.value, cases: [...bounds.until.cases] },
        }
      : {}),
  };
}

/** The handle a switch / choice lane leaves its step on (`case-<n>`,
 *  `default`, `option-<n>`); null for any other kind of lane, which has no
 *  row in the inspector to open. */
export function laneHandle(condition: LaneCondition): string | null {
  switch (condition.kind) {
    case "case":
      return `case-${condition.index}`;
    case "default":
      return "default";
    case "option":
      return `option-${condition.index}`;
    default:
      return null;
  }
}
