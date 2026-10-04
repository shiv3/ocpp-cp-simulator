import React, { useState } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type {
  ScenarioNode,
  ScenarioNodeType,
} from "../../../../cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { stepSummary, type StepLane } from "../../../lib/scenarioSteps";
import { layoutSteps, stepIndexOf } from "../../../lib/stepLayout";
import type { ScenarioRunState } from "../../../lib/useScenarioRun";
import AddStepPicker from "../edit/AddStepPicker";
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

interface StepBoxProps {
  step: ScenarioNode;
  index: number | null;
  phase: BoxPhase;
  failed: boolean;
  state?: ScenarioRunState;
  selected: boolean;
  onSelect?: (nodeId: string) => void;
  /** The editor names each box for its selection button. */
  editable?: boolean;
}

const StepBox: React.FC<StepBoxProps> = ({
  step,
  index,
  phase,
  failed,
  state,
  selected,
  onSelect,
  editable,
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
    phase === "todo" && "opacity-55",
    phase === "current" && live && CURRENT_RING[live],
    failed && "ring-2 ring-cx-rose",
    selected && "outline outline-2 outline-cx-accent",
  );

  return (
    <li data-step-id={step.id} data-phase={failed ? "failed" : phase}>
      {onSelect ? (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={
            editable ? `Select step ${index}: ${nodeTitle(step)}` : undefined
          }
          onClick={() => onSelect(step.id)}
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

/** "+ Add step" under a lane; opens the step picker in place. */
const AddStepSlot: React.FC<{
  label?: string;
  onPick: (type: ScenarioNodeType) => void;
}> = ({ label, onPick }) => {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="mt-1.5">
        <AddStepPicker
          onPick={(type) => {
            onPick(type);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => setOpen(true)}
      className="mt-1.5 w-full rounded-[10px] border border-dashed border-cx-border-strong py-2 text-[13px] font-medium text-cx-muted hover:text-cx-fg"
    >
      + Add step
    </button>
  );
};

/**
 * The run's steps as boxes stacked top to bottom: the chain, then — when the
 * scenario forks — one column per branch, side by side, each under a lane tag
 * with its `done/total`. Only a `supported` layout belongs here; the caller
 * shows `RunTimeline` for the rest.
 */
const StepsView: React.FC<StepRunViewProps> = (props) => {
  const {
    layout,
    currentNodeId,
    state,
    selectedStepId,
    onSelectStep,
    editable = false,
    onAddStep,
    onAddBranch,
  } = props;

  if (!editable && layoutSteps(layout).length === 0) {
    return <p className="text-sm text-cx-muted">This scenario has no steps.</p>;
  }

  const addSlot = (lane: StepLane, label?: string) =>
    editable && onAddStep ? (
      <AddStepSlot label={label} onPick={(type) => onAddStep(lane, type)} />
    ) : null;

  const renderBox = (step: ScenarioNode) => (
    <StepBox
      key={step.id}
      step={step}
      index={stepIndexOf(layout, step.id)}
      phase={boxPhase(step.id, props)}
      failed={state === "error" && step.id === currentNodeId}
      state={state}
      selected={selectedStepId === step.id}
      onSelect={onSelectStep}
      editable={editable}
    />
  );

  return (
    <div>
      {layout.main.length > 0 && (
        <ol className="space-y-1.5">{layout.main.map(renderBox)}</ol>
      )}
      {addSlot("main")}
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
                <ol className="space-y-1.5">{branch.steps.map(renderBox)}</ol>
                {addSlot(index, `Add step to ${branch.name}`)}
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
