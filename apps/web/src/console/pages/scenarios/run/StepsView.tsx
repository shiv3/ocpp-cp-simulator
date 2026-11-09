import { useTranslation } from "react-i18next";
import React from "react";
import {
  Check,
  CornerDownRight,
  CornerLeftUp,
  GripVertical,
  Plus,
  Repeat,
} from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import {
  STEP_CATEGORIES,
  canAddBranch,
  findStepLane,
  laneLinkTarget,
  stepSummary,
  type StepLane,
} from "../../../lib/scenarioSteps";
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
          aria-label={t("scenarioRun.dragReorder")}
          title={t("scenarioRun.dragReorderHint")}
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
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
};

/** The drag reads the boxes where the browser put them: every box of the
 *  lane in document order, those inside a loop block included. */
function measureBoxes(lane: StepLane, root: HTMLElement | null): number[] {
  const list = root?.querySelector(`[data-lane-list="${lane}"]`);
  return Array.from(list?.querySelectorAll("[data-step-id]") ?? []).map(
    (el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    },
  );
}

/** Steps that wait (a delay or a trigger): a loop starting at one waits
 *  there first on every round. */
const WAIT_TYPES: ReadonlySet<string> = new Set(
  STEP_CATEGORIES.find((c) => c.label === "Wait & Trigger")?.types ?? [],
);

/**
 * A loop drawn as Scratch draws "forever": a C-shaped block whose top arm
 * says it repeats, whose left spine holds the repeated steps (`children`,
 * a list of boxes), and whose bottom arm says where the run goes back to.
 * The back edge is unconditional, so the loop repeats until the run ends.
 * The arms and the spine are tints over whatever is behind them, so the
 * block reads the same on a page, a card or a panel, in either theme.
 */
const LoopBlock: React.FC<{
  /** The step the loop goes back to (its first step). */
  target: string;
  /** Box numbers of the first and last repeated step. */
  from: number;
  to: number;
  /** The first repeated step waits (a delay or a trigger). */
  waitsFirst: boolean;
  /** A step inside is the run's current step. */
  active: boolean;
  /** Under the repeated steps, inside the block (the lane's "+ Add step"). */
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ target, from, to, waitsFirst, active, footer, children }) => {
  const { t } = useTranslation();
  const tint = active ? "bg-cx-purple/20" : "bg-cx-purple/12";
  return (
    <li
      data-loop-block=""
      data-loop-to={target}
      aria-label={t("scenarioRun.loopSteps", { from, to })}
      className="min-w-0"
    >
      <div
        className={cn(
          "flex min-h-7 flex-wrap items-center gap-x-1.5 rounded-t-[12px] rounded-br-[12px] px-2.5 py-1 text-xs",
          tint,
        )}
      >
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-cx-purple">
          <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("scenarioRun.loopForever")}
        </span>
        {waitsFirst && (
          <span className="text-cx-muted">
            · {t("scenarioRun.loopWaitsAt", { n: from })}
          </span>
        )}
      </div>
      <div className="flex">
        <div aria-hidden className={cn("w-3 shrink-0", tint)} />
        <div className="min-w-0 flex-1 py-1.5 pl-1.5">
          {children}
          {footer}
        </div>
      </div>
      <div
        className={cn(
          "flex min-h-6 items-center gap-1.5 rounded-b-[12px] rounded-tr-[12px] px-2.5 py-1 text-xs text-cx-fg2",
          tint,
        )}
      >
        <CornerLeftUp
          className="h-3.5 w-3.5 shrink-0 text-cx-purple"
          aria-hidden
        />
        {t("scenarioRun.loopBackArm", { n: from })}
      </div>
    </li>
  );
};

/** The hover zone between two boxes of a lane: a small `+` that opens the
 *  step picker for that place (as the old step list's insert slot). */
const InsertZone: React.FC<{ label: string; onOpen: () => void }> = ({
  label,
  onOpen,
}) => {
  const { t } = useTranslation();
  return (
    <li className="group/insert relative h-1.5">
      <div className="absolute inset-x-0 -top-[5px] z-10 flex h-4 items-center justify-center">
        <button
          type="button"
          aria-label={label}
          title={t("scenarioRun.insertStepHere")}
          onClick={onOpen}
          className="flex h-4 w-4 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted opacity-0 hover:border-cx-accent hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
};

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

  const { t } = useTranslation();
  const editing = useStepEditing(props, measureBoxes);
  const { drag } = editing;

  if (!editable && layoutSteps(layout).length === 0) {
    return <p className="text-sm text-cx-muted">{t("scenarioRun.noSteps")}</p>;
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
        {t("scenarioRun.addStepButton")}
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

  /** The way out of a lane closed by a link to another lane: back into the
   *  chain before the fork, or on into an earlier branch (a join). */
  const linkNote = (target: string) => {
    const n = stepIndexOf(layout, target) ?? "";
    const back = findStepLane(layout, target)?.lane === "main";
    const Icon = back ? Repeat : CornerDownRight;
    return (
      <p
        data-link-to={target}
        className="mt-1.5 flex items-center gap-1.5 text-xs text-cx-muted"
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {back
          ? t("scenarioRun.loopBack", { n })
          : t("scenarioRun.joinTo", { n })}
      </p>
    );
  };

  /**
   * A lane and how it ends. A link back into the same lane is a loop: the
   * steps from its target to the lane's end sit inside a C-shaped block (a
   * Scratch "forever"), the steps before it above the block. A link into
   * another lane is a one-line note under the lane. `addButton` is the
   * lane's "+ Add step": it appends inside the loop (the loop always closes
   * at the lane's last step), so it goes inside the block.
   */
  const renderLane = (
    steps: ScenarioNode[],
    lane: StepLane,
    addButton: React.ReactNode = null,
  ) => {
    const last = steps[steps.length - 1];
    const target = last ? laneLinkTarget(layout, last.id) : null;
    const loopStart =
      target === null ? -1 : steps.findIndex((s) => s.id === target);
    if (target === null || loopStart === -1) {
      return (
        <>
          <ol
            data-lane-list={lane}
            className={canInsert ? undefined : "space-y-1.5"}
          >
            {renderRange(steps, lane, 0, steps.length)}
          </ol>
          {target !== null && linkNote(target)}
          {addButton}
        </>
      );
    }
    return (
      <ol
        data-lane-list={lane}
        className={canInsert ? undefined : "space-y-1.5"}
      >
        {renderRange(steps, lane, 0, loopStart)}
        {loopStart > 0 && canInsert && gap(steps, lane, loopStart)}
        <LoopBlock
          target={target}
          from={stepIndexOf(layout, steps[loopStart].id) ?? 0}
          to={stepIndexOf(layout, last.id) ?? 0}
          waitsFirst={WAIT_TYPES.has(steps[loopStart].type ?? "")}
          active={steps
            .slice(loopStart)
            .some((s) => boxPhase(s.id, props) === "current")}
          footer={addButton}
        >
          <ol className={canInsert ? undefined : "space-y-1.5"}>
            {renderRange(steps, lane, loopStart, steps.length)}
          </ol>
        </LoopBlock>
      </ol>
    );
  };

  /** The gap before box `i` of a lane: the insert zone, or the open picker. */
  const gap = (steps: ScenarioNode[], lane: StepLane, i: number) =>
    editing.isSlotOpen(lane, i) ? (
      <li key={`gap-${i}`} className="py-1.5">
        {editing.picker}
      </li>
    ) : drag ? (
      <li key={`gap-${i}`} aria-hidden className="h-1.5" />
    ) : (
      <InsertZone
        key={`gap-${i}`}
        label={t("scenarioRun.insertBetween", {
          from: stepIndexOf(layout, steps[i - 1].id) ?? "",
          to: stepIndexOf(layout, steps[i].id) ?? "",
        })}
        onOpen={() => editing.openSlot(lane, i)}
      />
    );

  /** Boxes `from` (inclusive) to `to` (exclusive) of a lane, with the gaps
   *  between them when the editor can insert. */
  const renderRange = (
    steps: ScenarioNode[],
    lane: StepLane,
    from: number,
    to: number,
  ) => {
    const ids = steps.map((s) => s.id);
    return steps.slice(from, to).map((step, k) => {
      const i = from + k;
      return (
        <React.Fragment key={step.id}>
          {canInsert && i > from && gap(steps, lane, i)}
          {renderBox(step, lane, i, ids)}
        </React.Fragment>
      );
    });
  };

  return (
    <div ref={editing.rootRef}>
      {layout.main.length > 0
        ? renderLane(layout.main, "main", addSlot("main", layout.main.length))
        : addSlot("main", 0)}
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
                {renderLane(
                  branch.steps,
                  index,
                  addSlot(
                    index,
                    branch.steps.length,
                    t("scenarioRun.addToBranch", { name: branch.name }),
                  ),
                )}
              </div>
            );
          })}
        </div>
      )}
      {editable && onAddBranch && canAddBranch(layout) && (
        <button
          type="button"
          onClick={onAddBranch}
          className="mt-3 text-[13px] font-medium text-cx-accent hover:underline"
        >
          {t("scenarioRun.addParallelBranchButton")}
        </button>
      )}
    </div>
  );
};

export default StepsView;
