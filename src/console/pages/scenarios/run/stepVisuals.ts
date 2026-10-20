import {
  CircleDot,
  Gauge,
  Hourglass,
  type LucideIcon,
  Wrench,
  Zap,
} from "lucide-react";

import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import type {
  ScenarioNode,
  ScenarioNodeType,
} from "../../../../cp/application/scenario/ScenarioTypes";
import type { LiveRunState } from "../../../lib/scenarioRunState";
import {
  stepPhase,
  type StepLayout,
  type StepPhase,
} from "../../../lib/stepLayout";
import type { ScenarioRunState } from "../../../lib/useScenarioRun";
import { STEP_CATEGORIES, type StepLane } from "../../../lib/scenarioSteps";

/** The registry title of a step's type ("Status Change"), as the editor's
 *  step list and the run timeline show it. */
export function nodeTitle(node: ScenarioNode): string {
  const entry = isScenarioNodeType(node.type)
    ? NODE_FORM_REGISTRY[node.type]
    : undefined;
  return entry?.title ?? node.type ?? "Step";
}

// One look per palette category of the editor's "add step" picker, so a type
// reads the same in the picker, the step list and the run views. Full literal
// class strings: Tailwind only sees class names written out in source.
const CATEGORY_TILES: Record<string, { icon: LucideIcon; className: string }> =
  {
    Status: { icon: CircleDot, className: "bg-cx-emerald/14 text-cx-emerald" },
    Transaction: { icon: Zap, className: "bg-cx-blue/14 text-cx-blue" },
    "Meter & EV": { icon: Gauge, className: "bg-cx-amber/14 text-cx-amber" },
    "Wait & Trigger": {
      icon: Hourglass,
      className: "bg-cx-purple/14 text-cx-purple",
    },
    Advanced: { icon: Wrench, className: "bg-cx-gray/14 text-cx-gray" },
  };

/** The icon and colour classes of a step type's tile. */
export function tileFor(node: ScenarioNode): {
  icon: LucideIcon;
  className: string;
} {
  const category = STEP_CATEGORIES.find((c) =>
    (c.types as readonly string[]).includes(node.type ?? ""),
  );
  return CATEGORY_TILES[category?.label ?? "Advanced"];
}

export interface LaneStyle {
  /** CSS colour for SVG strokes and inline borders. */
  color: string;
  /** The lane letter's square. */
  letter: string;
}

/** Branch lanes in order: accent, purple, amber, emerald (then repeat). */
export const LANES: readonly LaneStyle[] = [
  { color: "var(--cx-accent)", letter: "bg-cx-accent text-cx-card" },
  { color: "var(--cx-purple)", letter: "bg-cx-purple text-cx-card" },
  { color: "var(--cx-amber)", letter: "bg-cx-amber text-cx-card" },
  { color: "var(--cx-emerald)", letter: "bg-cx-emerald text-cx-card" },
];

export function laneStyle(index: number): LaneStyle {
  return LANES[index % LANES.length];
}

export function laneLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/** The current box's ring, in the run state's colour (as RunStatePill's dot). */
export const CURRENT_RING: Record<LiveRunState, string> = {
  running: "ring-2 ring-cx-blue",
  waiting: "ring-2 ring-cx-amber",
  paused: "ring-2 ring-cx-gray",
  stepping: "ring-2 ring-cx-purple",
};

/** The current graph card: the state colour's border and a 4px tinted ring. */
export const CURRENT_CARD: Record<LiveRunState, string> = {
  running: "border-cx-blue ring-4 ring-cx-blue/15",
  waiting: "border-cx-amber ring-4 ring-cx-amber/15",
  paused: "border-cx-gray ring-4 ring-cx-gray/15",
  stepping: "border-cx-purple ring-4 ring-cx-purple/15",
};

export interface StepRunViewProps {
  layout: StepLayout;
  /** The run's position. Leave `state` out for a definition with no run (the
   *  Library's panel): the boxes then carry no phase at all. */
  currentNodeId?: string | null;
  executedNodeIds?: readonly string[];
  state?: ScenarioRunState;
  selectedStepId?: string | null;
  onSelectStep?: (nodeId: string) => void;
  /** The editor's views: each step gets an accessible "Select step" name,
   *  `+` controls to add or insert a step, a way to add a parallel branch,
   *  drag to reorder within a lane, and Alt+ArrowUp/Down / Delete on a
   *  focused step. The run views leave it off. */
  editable?: boolean;
  /** editable: a step type picked for `index` of `lane` (the lane's length
   *  appends). */
  onInsertStep?: (
    lane: StepLane,
    index: number,
    type: ScenarioNodeType,
  ) => void;
  /** editable: move a step `delta` places within its lane (a drag, or
   *  Alt+ArrowUp/Down). */
  onMoveStep?: (nodeId: string, delta: number) => void;
  /** editable: remove a step; `confirm` when it came from the keyboard, so
   *  the editor asks first. */
  onDeleteStep?: (nodeId: string, options: { confirm: boolean }) => void;
  /** editable: add a parallel branch. */
  onAddBranch?: () => void;
}

export type BoxPhase = StepPhase | "plain";

/** Phase of one step under the view's props ("plain" without a run). */
export function boxPhase(
  nodeId: string,
  props: Pick<StepRunViewProps, "currentNodeId" | "executedNodeIds" | "state">,
): BoxPhase {
  if (props.state === undefined) return "plain";
  return stepPhase(
    nodeId,
    props.currentNodeId ?? null,
    props.executedNodeIds ?? [],
    props.state,
  );
}
