import { useTranslation } from "react-i18next";
import React from "react";
import { Check, GripVertical } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../../components/RunStatePill";
import { type ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../../lib/scenarioRunState";
import { stepSummary } from "../../../../lib/scenarioSteps";
import type { ScenarioRunState } from "../../../../lib/useScenarioRun";
import { type LaneDragHandlers } from "../../../../lib/useLaneDrag";
import type { useStepIssues } from "../../edit/issueMarkUi";
import IssueBadge from "../../edit/IssueBadge";
import StepTile from "../StepTile";
import { CURRENT_RING, nodeTitle, type BoxPhase } from "../stepVisuals";

/** The editor's extras on a box: drag, the keyboard, the drop line. */
export interface StepBoxEditing {
  /** Absent: the box cannot be dragged (a branch point). */
  dragHandlers?: LaneDragHandlers;
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Px the box follows the pointer by while dragged, else null. */
  dragOffset: number | null;
  /** The drop line, above or below this box. */
  dropLine: "above" | "below" | null;
}

export interface StepBoxProps {
  step: ScenarioNode;
  index: number | null;
  phase: BoxPhase;
  failed: boolean;
  state?: ScenarioRunState;
  selected: boolean;
  onSelect?: (nodeId: string) => void;
  /** The editor: an accessible name per box, the grab handle and keys. */
  editing?: StepBoxEditing;
  /** The step's diagnostics (`useStepIssues`). */
  marked?: ReturnType<ReturnType<typeof useStepIssues>>;
  /** The element: a list item of its lane, or a `div` heading a branch
   *  point's block. */
  as?: "li" | "div";
  /** The box is block `blockIndex` of its lane (what a drag measures). */
  blockIndex?: number;
  /** Outlined: the step is in the range an inspector action would affect. */
  ranged?: boolean;
}

export const StepBox: React.FC<StepBoxProps> = ({
  step,
  index,
  phase,
  failed,
  state,
  selected,
  onSelect,
  editing,
  marked,
  as: Tag = "li",
  blockIndex,
  ranged,
}) => {
  const { t } = useTranslation();
  const live = state !== undefined && isLiveRunState(state) ? state : null;
  const body = (
    <>
      <span className="w-[18px] shrink-0 text-right font-mono text-[11px] text-cx-faint">
        {index}
      </span>
      <StepTile node={step} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-cx-fg">
          {nodeTitle(step)}
        </span>
        <span className="block truncate text-xs text-cx-muted">
          {stepSummary(step)}
        </span>
      </span>
      {phase === "current" && live && <RunStatePill state={live} />}
      {failed ? (
        <span
          aria-label={t("scenarioRun.phase.failed")}
          className="flex h-4 w-4 items-center justify-center rounded-full bg-cx-rose/14 text-[11px] font-semibold text-cx-rose"
        >
          !
        </span>
      ) : (
        phase === "done" && (
          <Check
            aria-label={t("scenarioRun.phase.done")}
            className="h-4 w-4 text-cx-emerald"
          />
        )
      )}
      {marked?.description}
    </>
  );
  const className = cn(
    "flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] bg-cx-sub px-3 py-2",
    editing?.dragHandlers && "pl-7",
    phase === "todo" && "opacity-55",
    phase === "current" && live && CURRENT_RING[live],
    failed && "ring-2 ring-cx-rose",
    marked?.style?.inset,
    marked?.highlighted && marked.style?.glow,
    selected && "outline outline-2 outline-cx-accent",
  );
  const dragOffset = editing?.dragOffset ?? null;

  return (
    <Tag
      data-step-id={step.id}
      data-block={blockIndex}
      data-phase={failed ? "failed" : phase}
      data-range-highlight={ranged ? "hint" : undefined}
      className={cn(
        (editing || marked?.mark) && "relative",
        ranged && "rounded-[10px] ring-2 ring-cx-purple ring-offset-1",
        dragOffset !== null &&
          "z-20 rounded-[10px] shadow-[0_8px_24px_rgba(20,20,30,0.18)]",
      )}
      style={
        dragOffset !== null
          ? { transform: `translateY(${dragOffset}px)` }
          : undefined
      }
    >
      {editing?.dropLine && (
        <span
          aria-hidden
          data-drop-indicator=""
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-cx-accent",
            editing.dropLine === "above" ? "-top-1" : "-bottom-1",
          )}
        />
      )}
      {editing?.dragHandlers && (
        // Pointer only (out of the tab order): the box itself takes
        // Alt+ArrowUp/Down.
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("scenarioRun.dragReorder")}
          title={t("scenarioRun.dragReorderHint")}
          className="absolute inset-y-0 left-0 z-10 flex w-6 cursor-grab touch-none items-center justify-center rounded-l-[10px] text-cx-faint hover:text-cx-fg active:cursor-grabbing"
          {...editing.dragHandlers}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      {marked?.mark && (
        <IssueBadge
          mark={marked.mark}
          className="absolute -top-2.5 right-8 z-10"
        />
      )}
      {onSelect ? (
        <button
          type="button"
          aria-pressed={selected}
          data-step-select
          aria-label={
            editing
              ? t("scenarioRun.selectStep", {
                  n: index ?? "",
                  title: nodeTitle(step),
                })
              : undefined
          }
          onClick={() => onSelect(step.id)}
          onKeyDown={editing?.onKeyDown}
          className={className}
          {...marked?.cardProps}
        >
          {body}
        </button>
      ) : (
        <div className={className} {...marked?.cardProps}>
          {body}
        </div>
      )}
    </Tag>
  );
};

export default StepBox;
