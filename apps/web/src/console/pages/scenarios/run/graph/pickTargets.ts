import {
  canSetLaneExit,
  canWrapInLoop,
  firstNodeOf,
  seqAt,
  type SeqPath,
} from "../../../../lib/blockTree";
import { idsOf, type PickTarget } from "./graphShared";
import type { StepTreeViewProps } from "../stepVisuals";

type Tree = StepTreeViewProps["tree"];

/** What each step of the lane would do as the target of the pick. */
export const loopTargets = (tree: Tree, path: SeqPath, index: number) => {
  const out = new Map<string, PickTarget>();
  const lane = seqAt(tree, path);
  if (!lane) return out;
  for (let from = 0; from < Math.min(index, lane.blocks.length); from++) {
    out.set(firstNodeOf(lane.blocks[from]).id, {
      cap: canWrapInLoop(tree, path, from, index - 1),
      ids: idsOf(lane.blocks.slice(from, index)),
    });
  }
  return out;
};

export const laneTargets = (tree: Tree, path: SeqPath) => {
  const out = new Map<string, PickTarget>();
  const m = /^(.*)\/(\d+)\/lanes\/\d+$/.exec(path);
  const parent = m ? seqAt(tree, m[1]) : null;
  if (!m || !parent) return out;
  for (let j = Number(m[2]) + 1; j < parent.blocks.length; j++) {
    const id = firstNodeOf(parent.blocks[j]).id;
    out.set(id, {
      cap: canSetLaneExit(tree, path, id),
      // The steps the lane would skip, and the one it continues at.
      ids: idsOf(parent.blocks.slice(Number(m[2]) + 1, j + 1)),
    });
  }
  return out;
};
