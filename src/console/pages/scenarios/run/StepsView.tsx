import React from "react";
import { Check, GripVertical, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type { ScenarioNode } from "../../../../cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { stepSummary, type StepLane } from "../../../lib/scenarioSteps";
import { layoutSteps, stepIndexOf } from "../../../lib/stepLayout";
import {
  dropNeighbours,
  type LaneDragHandlers,
} from "../../../lib/useLaneDrag";
import type { ScenarioRunState } from "../../../lib/useScenarioRun";
import { useStepEditing } from "../edit/stepEditing";
import StepTile from "./StepTile";
import {
  CURRENT_RING,
  boxPhase,
  laneLetter,
  laneStyle,
  nodeTitle,
  type BoxPhase,
  type StepRunViewProps,
} from "./stepVisuals";

export type { StepRunViewProps } from "./stepVisuals";

/** The editor's extras on a box: drag, the keyboard, the drop line. */
interface StepBoxEditing {
  dragHandlers: LaneDragHandlers;
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Px the box follows the pointer by while dragged, else null. */
  dragOffset: number | null;
  /** The drop line, above or below this box. */
  dropLine: "above" | "below" | null;
}

interface StepBoxProps {
  step: ScenarioNode;
  index: number | null;
  phase: BoxPhase;
  failed: boolean;
  state?: ScenarioRunState;
  selected: boolean;
  onSelect?: (nodeId: string) => void;
  /** The editor: an accessible name per box, the grab handle and keys. */
  editing?: StepBoxEditing;
}

const StepBox: React.FC<StepBoxProps> = ({
  step,
  index,
  phase,
  failed,
  state,
  selected,
  onSelect,
  editing,
}) => {
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
          aria-label="failed"
          className="flex h-4 w-4 items-center justify-center rounded-full bg-cx-rose/14 text-[11px] font-semibold text-cx-rose"
        >
          !
        </span>
      ) : (
        phase === "done" && (
          <Check aria-label="done" className="h-4 w-4 text-cx-emerald" />
        )
      )}
    </>
  );
  const className = cn(
    "flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] bg-cx-sub px-3 py-2",
    editing && "pl-7",
    phase === "todo" && "opacity-55",
    phase === "current" && live && CURRENT_RING[live],
    failed && "ring-2 ring-cx-rose",
    selected && "outline outline-2 outline-cx-accent",
  );
  const dragOffset = editing?.dragOffset ?? null;

  return (
    <li
      data-step-id={step.id}
      data-phase={failed ? "failed" : phase}
      className={cn(
        editing && "relative",
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
      {editing && (
        // Pointer only (out of the tab order): the box itself takes
        // Alt+ArrowUp/Down.
        <button
          type="button"
          tabIndex={-1}
          aria-label="Drag to reorder"
          title="Drag to reorder (or Alt+↑/↓ on the step)"
          className="absolute inset-y-0 left-0 z-10 flex w-6 cursor-grab touch-none items-center justify-center rounded-l-[10px] text-cx-faint hover:text-cx-fg active:cursor-grabbing"
          {...editing.dragHandlers}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      {onSelect ? (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={
            editing ? `Select step ${index}: ${nodeTitle(step)}` : undefined
          }
          onClick={() => onSelect(step.id)}
          onKeyDown={editing?.onKeyDown}
          className={className}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
};

/** The drag reads the boxes where the browser put them. */
function measureBoxes(lane: StepLane, root: HTMLElement | null): number[] {
  const list = root?.querySelector(`[data-lane-list="${lane}"]`);
  return Array.from(list?.children ?? [])
    .filter((el) => el.hasAttribute("data-step-id"))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
}

/** The hover zone between two boxes of a lane: a small `+` that opens the
 *  step picker for that place (as the old step list's insert slot). */
const InsertZone: React.FC<{ label: string; onOpen: () => void }> = ({
  label,
  onOpen,
}) => (
  <li className="group/insert relative h-1.5">
    <div className="absolute inset-x-0 -top-[5px] z-10 flex h-4 items-center justify-center">
      <button
        type="button"
        aria-label={label}
        title="Insert a step here"
        onClick={onOpen}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted opacity-0 hover:border-cx-accent hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  </li>
);

/**
 * The run's steps as boxes stacked top to bottom: the chain, then — when the
 * scenario forks — one column per branch, side by side, each under a lane tag
 * with its `done/total`. Only a `supported` layout belongs here; the caller
 * shows `RunTimeline` for the rest. `editable` (the editor) adds a `+`
 * between two boxes of a lane, "+ Add step" under each lane, a grab handle
 * to drag a box within its lane, and the keys of `useStepEditing`.
 */
const StepsView: React.FC<StepRunViewProps> = (props) => {
  const {
    layout,
    currentNodeId,
    state,
    selectedStepId,
    onSelectStep,
    editable = false,
    onInsertStep,
    onAddBranch,
  } = props;

  const editing = useStepEditing(props, measureBoxes);
  const { drag } = editing;

  if (!editable && layoutSteps(layout).length === 0) {
    return <p className="text-sm text-cx-muted">This scenario has no steps.</p>;
  }

  const canInsert = editable && onInsertStep !== undefined;

  const addSlot = (lane: StepLane, length: number, label?: string) => {
    if (!canInsert) return null;
    if (editing.isSlotOpen(lane, length)) {
      return <div className="mt-1.5">{editing.picker}</div>;
    }
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => editing.openSlot(lane, length)}
        className="mt-1.5 w-full rounded-[10px] border border-dashed border-cx-border-strong py-2 text-[13px] font-medium text-cx-muted hover:text-cx-fg"
      >
        + Add step
      </button>
    );
  };

  const renderBox = (
    step: ScenarioNode,
    lane: StepLane,
    laneIndex: number,
    laneIds: string[],
  ) => {
    let dropLine: StepBoxEditing["dropLine"] = null;
    if (drag && drag.lane === lane && drag.to !== drag.from) {
      const { above, below } = dropNeighbours(laneIds, drag);
      if (below === step.id) dropLine = "above";
      else if (below === null && above === step.id) dropLine = "below";
    }
    return (
      <StepBox
        key={step.id}
        step={step}
        index={stepIndexOf(layout, step.id)}
        phase={boxPhase(step.id, props)}
        failed={state === "error" && step.id === currentNodeId}
        state={state}
        selected={selectedStepId === step.id}
        onSelect={onSelectStep}
        editing={
          editable
            ? {
                dragHandlers: editing.dragHandlers({
                  id: step.id,
                  lane,
                  index: laneIndex,
                }),
                onKeyDown: editing.onStepKeyDown(step.id),
                dragOffset: drag?.id === step.id ? drag.offset : null,
                dropLine,
              }
            : undefined
        }
      />
    );
  };

  const renderLane = (steps: ScenarioNode[], lane: StepLane) => {
    const ids = steps.map((s) => s.id);
    if (!canInsert) {
      return (
        <ol data-lane-list={lane} className="space-y-1.5">
          {steps.map((step, i) => renderBox(step, lane, i, ids))}
        </ol>
      );
    }
    // The gaps between boxes are the insert zones (or the open picker).
    return (
      <ol data-lane-list={lane}>
        {steps.map((step, i) => (
          <React.Fragment key={step.id}>
            {i > 0 &&
              (editing.isSlotOpen(lane, i) ? (
                <li className="py-1.5">{editing.picker}</li>
              ) : drag ? (
                <li aria-hidden className="h-1.5" />
              ) : (
                <InsertZone
                  label={`Insert step between ${stepIndexOf(layout, steps[i - 1].id)} and ${stepIndexOf(layout, step.id)}`}
                  onOpen={() => editing.openSlot(lane, i)}
                />
              ))}
            {renderBox(step, lane, i, ids)}
          </React.Fragment>
        ))}
      </ol>
    );
  };

  return (
    <div ref={editing.rootRef}>
      {layout.main.length > 0 && renderLane(layout.main, "main")}
      {addSlot("main", layout.main.length)}
      {layout.fork && (
        <div
          data-testid="step-branches"
          className={cn(
            "grid auto-cols-[minmax(250px,1fr)] grid-flow-col gap-3 overflow-x-auto",
            layout.main.length > 0 &&
              "mt-1.5 border-t-2 border-cx-border-strong pt-3",
          )}
        >
          {layout.fork.branches.map((branch, index) => {
            const lane = laneStyle(index);
            const done = branch.steps.filter(
              (step) => boxPhase(step.id, props) === "done",
            ).length;
            return (
              <div key={index} data-lane={index} className="min-w-0">
                <div
                  data-testid="lane-tag"
                  className="mb-2 flex items-center gap-2"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                      lane.letter,
                    )}
                  >
                    {laneLetter(index)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-cx-fg2">
                    {branch.name}
                  </span>
                  <span className="font-mono text-xs text-cx-muted">
                    {state === undefined
                      ? branch.steps.length
                      : `${done}/${branch.steps.length}`}
                  </span>
                </div>
                {renderLane(branch.steps, index)}
                {addSlot(
                  index,
                  branch.steps.length,
                  `Add step to ${branch.name}`,
                )}
              </div>
            );
          })}
        </div>
      )}
      {editable && onAddBranch && (
        <button
          type="button"
          onClick={onAddBranch}
          className="mt-3 text-[13px] font-medium text-cx-accent hover:underline"
        >
          + Add parallel branch
        </button>
      )}
    </div>
  );
};

export default StepsView;
