import {
  treeNodes,
  type Capability,
  type SeqPath,
} from "../../../../lib/blockTree";
import { WAIT_STEP_TYPES } from "../../../../lib/scenarioSteps";

export const TODO_STROKE = "var(--cx-border-strong)";
export const LOOP_STROKE = "var(--cx-purple)";
/** The step picker opened from a `+` (and the room it needs below). */
export const PICKER_W = 520;
export const PICKER_H = 330;
/** Room the bounds editor needs below its loop before it opens upward. */
export const BOUNDS_PANEL_H = 300;
/** Scrolls a freshly opened bounds editor into view in the canvas. */
export const revealBounds = (el: HTMLElement | null) =>
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
export const WAIT_TYPES: ReadonlySet<string> = new Set(WAIT_STEP_TYPES);

/** Picking a target on the canvas: after Repeat from a `+` (the loop goes
 *  back to an earlier step of the lane) or a lane's connect arrow (the lane
 *  continues at a later step). `origin`: where the arrow starts. */
export type Pick =
  | { kind: "loop"; path: SeqPath; index: number; origin: Point }
  | {
      kind: "lane";
      path: SeqPath;
      /** Lane letter, for the words. */
      lane: string;
      origin: Point;
    };

export interface Point {
  x: number;
  y: number;
}

/** What clicking a step would do while picking: `cap` says whether, `ids`
 *  are the steps the result affects (the range to highlight). */
export interface PickTarget {
  cap: Capability;
  ids: string[];
  /** Loop: the numbers of the first and last step the loop would repeat. */
  from?: number;
  to?: number;
}

export const idsOf = (
  blocks: ReadonlyArray<import("../../../../lib/blockTree").Block>,
) =>
  treeNodes({
    root: {
      path: "",
      blocks: [...blocks],
      exit: { kind: "stop", reason: "noEdge" },
    },
    detached: [],
    origin: null,
  }).map((n) => n.id);
