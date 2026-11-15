import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { type LinkEdge, type LoopBlock, type SeqPath } from "../blockTree";

export const NODE_W = 228;
export const NODE_H = 52;
/** A lane's least width (a card and its margins). */
export const LANE_W = 262;
/** Card top to the next card's top in a column. */
export const ROW_H = 76;
/** The gap between two cards of a column. */
export const GAP = ROW_H - NODE_H;
export const START_R = 5;
export const END_R = 6;
/** Gap between a card and the end ring (the editor's leaves room for the
 *  `+` disc on the path). */
export const CAP_GAP = 22;
export const EDIT_CAP_GAP = 46;
/** A fork card's bottom to its lane tags' top. */
export const FORK_DROP = 46;
export const TAG_H = 22;
/** The widest a lane tag grows for a long condition; past it the text is
 *  cut (the full text is the tag's tooltip). */
export const TAG_MAX_W = 380;
/** Room a tag has beside its text: the lane letter, the step count and the
 *  remove button, plus padding. */
export const TAG_CHROME = 76;
/** Monospace 11px glyph advance. */
export const TAG_CHAR_W = 6.6;
/** The width a lane tag needs to show `text` whole, from the card's width
 *  up to `TAG_MAX_W`. */
export function tagWidth(text: string): number {
  return Math.min(
    TAG_MAX_W,
    Math.max(NODE_W, Math.ceil(text.length * TAG_CHAR_W) + TAG_CHROME),
  );
}
/** A lane's side margin around its tag. */
export const TAG_MARGIN = 16;
/** Lowest lane's bottom to the merge point, and the merge point to the
 *  next card. */
export const MERGE_DROP = 26;
/** A loop's rectangle: the channel its return arc runs in (left), a pad
 *  (top), and the band at the bottom where the arc turns and, under it,
 *  the label sits (out of the way of the line entering the loop). */
export const LOOP_LEFT = 30;
export const LOOP_RIGHT = 10;
export const LOOP_TOP = 14;
export const LOOP_BOTTOM = 46;
/** Extra band in the editor: the loop's buttons get a row under its label. */
export const LOOP_BUTTON_ROW = 22;
/** The arc's turn below the body. */
export const LOOP_TURN = 20;
/** Lanes that leave a loop stand this far right of its rectangle. */
export const LEAVING_GAP = 16;
/** A jump's channel runs this far beside the cards it passes, plus a step
 *  per jump already drawn there; it enters its target this far in from the
 *  target's corner. */
export const LINK_SWING = 30;
export const LINK_STEP = 14;
export const LINK_INSET = 18;
/** Room the editor's "+ branch" pill needs right of a branch point's card
 *  inside a loop's rectangle (beyond the lane's own margin). */
export const PILL_ROOM = 64;
/** The column of steps nothing reaches starts this far right. */
export const DETACHED_GAP = 40;
export const MARGIN_TOP = 34;

export interface Point {
  x: number;
  y: number;
}

/** A card: the box of a step (a branch point's node too). */
export interface GraphCard {
  node: ScenarioNode;
  /** Centre x, top y. */
  x: number;
  y: number;
  /** Its sequence and block index (what a drag moves within). */
  seqPath: SeqPath;
  index: number;
  /** The lane colour (the index of the lane it sits in). */
  lane: number;
  /** A branch point's node: it stays where it is. */
  isFork: boolean;
}

/** A drawn edge (or the part of one between two drawn points). */
export interface GraphPath {
  key: string;
  d: string;
  edgeId?: string;
  lane: number;
  done: boolean;
  /** The node it goes into, `end`, `merge` or `tag`. */
  to: string;
  mid: Point;
}

/** A jump (a link): dashed, orthogonal. */
export interface GraphLink {
  key: string;
  d: string;
  /** The corners of the route (`d` rounds them). */
  points: Point[];
  /** True when no clean route existed and the dashed curve was drawn. */
  fallback: boolean;
  edgeId: string;
  from: string;
  to: string;
  role: LinkEdge["role"];
  lane: number;
  mid: Point;
}

/** A lane tag: the lane letter and its condition chip. */
export interface GraphTag {
  key: string;
  forkId: string;
  laneIndex: number;
  /** The fork's handle the lane leaves on (`case-<n>`, `default`,
   *  `option-<n>`), null for a lane with no row in the inspector. */
  handle: string | null;
  /** Centre x, top y, width. */
  x: number;
  y: number;
  w: number;
  text: string;
  dead: boolean;
  /** The lane leaves the loop its branch point is in. */
  leaves: boolean;
  /** Steps in the lane. */
  count: number;
}

export interface GraphLoop {
  key: string;
  headerId: string;
  rect: { x: number; y: number; w: number; h: number };
  /** The return arcs (one per way back), solid. */
  arcs: GraphPath[];
  /** Where the label starts (left, baseline-ish top). */
  label: Point;
  /** The repeated steps' numbers. */
  from: number;
  to: number;
  /** A switch / choice inside, a lane that leaves, or bounds: not
   *  "forever". */
  canExit: boolean;
  /** The loop's loop edge (schema 1.10), null for a plain back edge. */
  loopEdge: LoopBlock["loopEdge"];
  ids: string[];
}

/** A `+` of the editor. */
export interface GraphPlus {
  slot: { lane: SeqPath; index: number };
  label: string;
  x: number;
  y: number;
}

/** "+ branch" by a branch point (or START). */
export interface GraphPill {
  nodeId: string;
  x: number;
  y: number;
  label: string;
}

export interface TreeGraphGeometry {
  cards: GraphCard[];
  paths: GraphPath[];
  links: GraphLink[];
  tags: GraphTag[];
  loops: GraphLoop[];
  ends: Array<Point & { lane: number }>;
  merges: Point[];
  start: Point | null;
  discs: GraphPlus[];
  zones: GraphPlus[];
  pills: GraphPill[];
  /** Where "Steps nothing reaches" stands, when there are any. */
  detached: Point | null;
  /** Each sequence's block centres (y), in block order, for the drag. */
  centres: ReadonlyMap<SeqPath, number[]>;
  width: number;
  height: number;
}

/** An edge end waiting for what comes next: a card bottom, a tag bottom, a
 *  merge point. */
export interface Open {
  x: number;
  y: number;
  /** The edge drawn from here, when known. */
  edgeId: string | null;
  /** The node it leaves (for the run state); null for START. */
  from: string | null;
  lane: number;
  /** A fallthrough's target. */
  to?: string;
  /** `edgeId` is final, null included (a tag's or a merge point's line
   *  out: the edge was drawn into it). */
  fixed?: boolean;
}

export interface Ctx {
  /** The header of the innermost loop around, or null. */
  loopHeader: string | null;
  /** Lanes that leave that loop stand at this x (top-level forks of its
   *  body only); null elsewhere. */
  outsideX: number | null;
  lane: number;
}

export interface TreeGraphOptions {
  editable: boolean;
  /** "done" / "current" mark a path travelled. */
  phaseOf: (nodeId: string) => string;
}
