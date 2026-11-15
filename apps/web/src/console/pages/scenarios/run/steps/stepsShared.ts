import {
  CornerDownRight,
  GitBranch,
  Shuffle,
  Split,
  Timer,
} from "lucide-react";
import type React from "react";

import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { connectionRule } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import type { MessageKey } from "../../../../../i18n";
import type {
  Block,
  ForkBlock,
  ForkKind,
  Lane,
  SeqPath,
} from "../../../../lib/blockTree";
import { firstNodeOf } from "../../../../lib/blockTree";
import { WAIT_STEP_TYPES } from "../../../../lib/scenarioSteps";

/** The drag reads the blocks where the browser put them: every block of
 *  the sequence (`data-block`), in document order. A fork or a loop is one
 *  block: a step moves only among the blocks of its own sequence. */
export function measureBlocks(
  path: SeqPath,
  root: HTMLElement | null,
): number[] {
  const list = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-lane-list]") ?? [],
  ).find((el) => el.dataset.laneList === path);
  return Array.from(list?.children ?? [])
    .filter((el) => el.hasAttribute("data-block"))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
}

/** The step types a Repeat block made in the middle of a lane cannot start
 *  with: its bounds are checked after the step, which must then go on (not a
 *  switch / choice, not an End). By type, with the reason. */
export function midLaneLoopRefusals(
  t: (key: MessageKey) => string,
): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const type of Object.values(ScenarioNodeType)) {
    const rule = connectionRule(type);
    if (rule.out !== "next" || type === ScenarioNodeType.END) {
      out[type] = t("scenarios.editor.cannot.loopNeedsNextStep");
    }
  }
  return out;
}

/** Steps that wait (a delay or a trigger): a loop starting at one waits
 *  there first on every round. */
export const WAIT_TYPES: ReadonlySet<string> = new Set(WAIT_STEP_TYPES);

/** Steps that may end their branch on a run (a switch or choice whose picked
 *  handle has no edge): a loop holding one is not "forever". */
export const EXIT_TYPES: ReadonlySet<string> = new Set([
  ScenarioNodeType.SWITCH,
  ScenarioNodeType.CHOICE,
]);

export const FORK_ICONS: Record<
  ForkKind,
  React.ComponentType<{ className?: string }>
> = {
  start: Split,
  parallel: Split,
  switch: GitBranch,
  choice: Shuffle,
  timeout: Timer,
  extra: CornerDownRight,
};

/** Where a sequence is drawn: inside which loop's block, if any. */
export interface SeqContext {
  /** The first step of the innermost loop around it, or null. */
  loopHeader: string | null;
  /** That loop's lanes that leave it, drawn after its block. */
  exits: LeavingLane[] | null;
  /** The steps drawn inside that loop's block. */
  inLoop: string[] | null;
}

export interface LeavingLane {
  fork: ForkBlock;
  lane: Lane;
  laneIndex: number;
}

export const blockKey = (block: Block) =>
  `${block.kind}:${firstNodeOf(block).id}`;
