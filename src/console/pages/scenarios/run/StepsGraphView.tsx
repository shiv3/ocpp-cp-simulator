import React from "react";
import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type { ScenarioNode } from "../../../../cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { stepSummary, type StepLane } from "../../../lib/scenarioSteps";
import {
  layoutSteps,
  stepIndexOf,
  type StepLayout,
} from "../../../lib/stepLayout";
import { dropNeighbours } from "../../../lib/useLaneDrag";
import { useStepEditing, type InsertSlot } from "../edit/stepEditing";
import StepTile from "./StepTile";
import {
  CURRENT_CARD,
  boxPhase,
  laneLetter,
  laneStyle,
  nodeTitle,
  type BoxPhase,
  type StepRunViewProps,
} from "./stepVisuals";

// The mock's grid: lane 0's centre at X0, the first card's top at Y0.
const LANE_W = 262;
const ROW_H = 76;
const X0 = 134;
const Y0 = 62;
const NODE_W = 228;
const NODE_H = 52;
/** How far below the fork node a branch's first card starts. */
const BRANCH_DROP = 1.9 * ROW_H;
const START_R = 5;
const END_R = 6;
/** Gap between a card and the start dot / end ring. */
const CAP_GAP = 22;
/** The editor's gap before an end ring: room for the `+` disc on the path. */
const EDIT_CAP_GAP = 46;
const TODO_STROKE = "var(--cx-border-strong)";
/** The step picker opened from a `+` (and the room it needs below). */
const PICKER_W = 260;
const PICKER_H = 330;

interface PlacedNode {
  step: ScenarioNode;
  /** The drawing lane (a branch's index; the chain is lane 0). */
  lane: number;
  top: number;
  /** The editing lane (the chain is "main") and the index in it. */
  stepLane: StepLane;
  index: number;
}

interface GraphPath {
  key: string;
  d: string;
  lane: number;
  /** The target node's id, or `end`. */
  to: string;
  done: boolean;
}

/** A `+` of the editor: where a picked step goes, centred at (x, y). */
interface PlusPoint {
  slot: InsertSlot;
  label: string;
  x: number;
  y: number;
}

interface GraphGeometry {
  placed: PlacedNode[];
  paths: GraphPath[];
  ends: Array<{ lane: number; y: number }>;
  tags: Array<{ lane: number; name: string; top: number }>;
  startY: number;
  /** The `+` discs after a lane's last card (or on an empty lane). */
  discs: PlusPoint[];
  /** The `+` on hover between two cards of a lane. */
  zones: PlusPoint[];
  /** Where "+ branch" sits: beside the fork node, else the last chain card. */
  branchPill: { left: number; top: number };
  width: number;
  height: number;
}

const laneX = (lane: number) => X0 + lane * LANE_W;

/** Straight within a lane; a cubic curve when it moves into another lane. */
function connect(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** Places every card, path, cap and (for the editor) `+` on the grid. */
function computeGeometry(
  layout: StepLayout,
  phaseOf: (id: string) => BoxPhase,
  editable: boolean,
): GraphGeometry {
  const capGap = editable ? EDIT_CAP_GAP : CAP_GAP;
  const travelled = (id: string) => {
    const phase = phaseOf(id);
    return phase === "done" || phase === "current";
  };
  const number = (id: string) => stepIndexOf(layout, id);

  const placed: PlacedNode[] = [];
  const paths: GraphPath[] = [];
  const ends: Array<{ lane: number; y: number }> = [];
  const tags: Array<{ lane: number; name: string; top: number }> = [];
  const discs: PlusPoint[] = [];
  const zones: PlusPoint[] = [];
  const startY = Y0 - CAP_GAP - START_R;

  // The chain: start dot, then lane 0 top to bottom.
  let prevBottom = startY + START_R;
  let prevId: string | null = null;
  layout.main.forEach((step, row) => {
    const top = Y0 + row * ROW_H;
    placed.push({ step, lane: 0, top, stepLane: "main", index: row });
    paths.push({
      key: `${prevId ?? "start"}->${step.id}`,
      d: connect(X0, prevBottom, X0, top),
      lane: 0,
      to: step.id,
      done: travelled(step.id),
    });
    if (prevId) {
      zones.push({
        slot: { lane: "main", index: row },
        label: `Insert step between ${number(prevId)} and ${number(step.id)}`,
        x: X0,
        y: (prevBottom + top) / 2,
      });
    }
    prevBottom = top + NODE_H;
    prevId = step.id;
  });

  const lastMain = layout.main[layout.main.length - 1];
  // The fork node (or, without a fork, the last chain card); START when the
  // chain is empty.
  const anchorTop = lastMain
    ? Y0 + (layout.main.length - 1) * ROW_H
    : Y0 - ROW_H;
  const branchPill = lastMain
    ? { left: X0 + NODE_W / 2 + 10, top: anchorTop + NODE_H / 2 - 11 }
    : { left: X0 + 14, top: startY - 11 };

  if (layout.fork) {
    const forkBottom = prevBottom;
    const firstTop = anchorTop + BRANCH_DROP;
    // The chain's own `+`: just under the fork node, before the paths split.
    discs.push({
      slot: { lane: "main", index: layout.main.length },
      label: lastMain
        ? `Add step after step ${number(lastMain.id)}`
        : "Add step before the branches",
      x: X0,
      y: forkBottom + 16,
    });
    layout.fork.branches.forEach((branch, lane) => {
      tags.push({ lane, name: branch.name, top: firstTop - 26 });
      let bottom = forkBottom;
      let fromX = X0;
      branch.steps.forEach((step, row) => {
        const top = firstTop + row * ROW_H;
        placed.push({ step, lane, top, stepLane: lane, index: row });
        paths.push({
          key: `${row === 0 ? (prevId ?? "start") : branch.steps[row - 1].id}->${step.id}`,
          d: connect(fromX, bottom, laneX(lane), top),
          lane,
          to: step.id,
          done: travelled(step.id),
        });
        if (row > 0) {
          zones.push({
            slot: { lane, index: row },
            label: `Insert step between ${number(branch.steps[row - 1].id)} and ${number(step.id)}`,
            x: laneX(lane),
            y: (bottom + top) / 2,
          });
        }
        bottom = top + NODE_H;
        fromX = laneX(lane);
      });
      const last = branch.steps[branch.steps.length - 1];
      const capTop = last ? bottom : firstTop;
      const endY = capTop + capGap + END_R;
      ends.push({ lane, y: endY });
      discs.push({
        slot: { lane, index: branch.steps.length },
        label: last
          ? `Add step after step ${number(last.id)}`
          : `Add step to ${branch.name}`,
        x: laneX(lane),
        y: capTop + capGap / 2,
      });
      paths.push({
        key: `${last?.id ?? prevId ?? "start"}->end-${lane}`,
        d: connect(fromX, bottom, laneX(lane), endY - END_R),
        lane,
        to: "end",
        done: last ? phaseOf(last.id) === "done" : false,
      });
    });
  } else {
    const endY = prevBottom + capGap + END_R;
    ends.push({ lane: 0, y: endY });
    discs.push({
      slot: { lane: "main", index: layout.main.length },
      label: lastMain
        ? `Add step after step ${number(lastMain.id)}`
        : "Add the first step",
      x: X0,
      y: prevBottom + capGap / 2,
    });
    paths.push({
      key: `${lastMain?.id ?? "start"}->end`,
      d: connect(X0, prevBottom, X0, endY - END_R),
      lane: 0,
      to: "end",
      done: lastMain ? phaseOf(lastMain.id) === "done" : false,
    });
  }

  const laneCount = Math.max(1, layout.fork?.branches.length ?? 1);
  let width = X0 + LANE_W * (laneCount - 0.5);
  // The "+ branch" pill may stand right of the only lane.
  if (editable) width = Math.max(width, branchPill.left + 96);
  const height = Math.max(...ends.map((e) => e.y)) + END_R + 16;

  return {
    placed,
    paths,
    ends,
    tags,
    startY,
    discs,
    zones,
    branchPill,
    width,
    height,
  };
}

/**
 * The run's steps drawn as connected cards on a fixed grid: the chain in
 * lane 0, a fork's branches curving into lanes of their own below it (the
 * first branch continues lane 0). Self-contained SVG + absolutely placed
 * cards — no graph library, the layout is the pure `deriveStepLayout`.
 *
 * `editable` makes it the editor's Graph view: a click selects a card (the
 * selected one gets a ✕), a `+` disc after the last card of the chain and of
 * each branch and a `+` on hover between two cards open the step picker,
 * "+ branch" by the fork adds a parallel branch, a card drags up or down
 * within its lane, and a focused card takes Alt+ArrowUp/Down and Delete.
 */
const StepsGraphView: React.FC<StepRunViewProps> = (props) => {
  const {
    layout,
    currentNodeId,
    state,
    selectedStepId,
    onSelectStep,
    editable = false,
    onInsertStep,
    onDeleteStep,
    onAddBranch,
  } = props;
  const phaseOf = (id: string): BoxPhase => boxPhase(id, props);
  const geometry = computeGeometry(layout, phaseOf, editable);
  const { placed, paths, ends, tags, startY } = geometry;

  // The grid is the layout: a lane's centres come from the placed cards.
  const editing = useStepEditing(props, (lane) =>
    placed.filter((p) => p.stepLane === lane).map((p) => p.top + NODE_H / 2),
  );
  const { drag } = editing;

  if (!editable && layoutSteps(layout).length === 0) {
    return <p className="text-sm text-cx-muted">This scenario has no steps.</p>;
  }

  const canInsert = editable && onInsertStep !== undefined;
  const openPlus = canInsert
    ? [...geometry.discs, ...geometry.zones].find((p) =>
        editing.isSlotOpen(p.slot.lane, p.slot.index),
      )
    : undefined;
  const pickerTop = openPlus ? openPlus.y + 14 : 0;
  const width = geometry.width;
  const height = openPlus
    ? Math.max(geometry.height, pickerTop + PICKER_H)
    : geometry.height;
  const live = state !== undefined && isLiveRunState(state) ? state : null;

  // The drop line: between the two cards the dragged one would land between.
  let dropLine: { left: number; top: number } | null = null;
  if (drag && drag.to !== drag.from) {
    const lanePlaced = placed.filter((p) => p.stepLane === drag.lane);
    const { above, below } = dropNeighbours(
      lanePlaced.map((p) => p.step.id),
      drag,
    );
    const half = (ROW_H - NODE_H) / 2;
    const at = lanePlaced.find((p) => p.step.id === (below ?? above));
    if (at) {
      dropLine = {
        left: laneX(at.lane) - NODE_W / 2,
        top: below ? at.top - half - 1 : at.top + NODE_H + half - 1,
      };
    }
  }

  const plusButton = (point: PlusPoint, hover: boolean) => (
    <div
      key={`${point.slot.lane}:${point.slot.index}`}
      // A hover zone covers the gap between the two cards; a disc stands on
      // its own.
      className={cn(
        "absolute z-10 flex items-center justify-center",
        hover && "group/insert",
      )}
      style={
        hover
          ? {
              left: point.x - NODE_W / 2,
              top: point.y - (ROW_H - NODE_H) / 2,
              width: NODE_W,
              height: ROW_H - NODE_H,
            }
          : { left: point.x - 9, top: point.y - 9, width: 18, height: 18 }
      }
    >
      <button
        type="button"
        aria-label={point.label}
        title={hover ? "Insert a step here" : "Add a step"}
        onClick={() => editing.openSlot(point.slot.lane, point.slot.index)}
        className={cn(
          "flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-cx-card",
          hover
            ? "border-cx-border-strong text-cx-muted opacity-0 hover:border-cx-accent hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
            : "border-cx-accent text-cx-accent hover:bg-cx-accent hover:text-cx-card",
        )}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <div
        ref={editing.rootRef}
        className="relative"
        style={{ width: Math.max(width, openPlus ? PICKER_W + 8 : 0), height }}
      >
        <svg
          aria-hidden
          width={width}
          height={height}
          data-graph-edges=""
          className="pointer-events-none absolute inset-0"
        >
          {paths.map((path) => (
            <path
              key={path.key}
              d={path.d}
              data-to={path.to}
              fill="none"
              strokeWidth={path.done ? 2 : 1.5}
              stroke={path.done ? laneStyle(path.lane).color : TODO_STROKE}
            />
          ))}
          <circle
            data-graph-start=""
            cx={X0}
            cy={startY}
            r={START_R}
            fill="var(--cx-faint)"
          />
          {ends.map((end) => (
            <circle
              key={end.lane}
              data-graph-end=""
              cx={laneX(end.lane)}
              cy={end.y}
              r={END_R}
              fill="var(--cx-card)"
              stroke="var(--cx-faint)"
              strokeWidth={2}
            />
          ))}
        </svg>

        {tags.map((tag) => (
          <div
            key={tag.lane}
            data-testid="lane-tag"
            className="absolute flex items-center gap-2"
            style={{
              left: laneX(tag.lane) - NODE_W / 2,
              top: tag.top,
              width: NODE_W,
            }}
          >
            <span
              aria-hidden
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                laneStyle(tag.lane).letter,
              )}
            >
              {laneLetter(tag.lane)}
            </span>
            <span className="truncate text-xs font-medium text-cx-fg2">
              {tag.name}
            </span>
          </div>
        ))}

        {placed.map(({ step, lane, top, stepLane, index }) => {
          const phase = phaseOf(step.id);
          const failed = state === "error" && step.id === currentNodeId;
          const selected = selectedStepId === step.id;
          const className = cn(
            "flex items-center gap-2 rounded-xl border-[1.5px] bg-cx-card px-2.5 text-left",
            phase === "current" && live
              ? CURRENT_CARD[live]
              : failed
                ? "border-cx-rose ring-4 ring-cx-rose/15"
                : phase !== "done" && "border-cx-border",
            selected && "outline outline-2 outline-cx-accent",
          );
          const place: React.CSSProperties = {
            left: laneX(lane) - NODE_W / 2,
            top,
            width: NODE_W,
            height: NODE_H,
          };
          // Done cards take their lane's colour (inline: any lane index).
          const doneBorder: React.CSSProperties =
            phase === "done" && !failed
              ? { borderColor: laneStyle(lane).color }
              : {};
          const body = (
            <>
              <StepTile node={step} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-cx-fg">
                  {nodeTitle(step)}
                </span>
                <span className="block truncate text-xs text-cx-muted">
                  {stepSummary(step)}
                </span>
              </span>
              {phase === "current" && live && <RunStatePill state={live} />}
            </>
          );

          if (editable) {
            const number = stepIndexOf(layout, step.id);
            const dragged = drag?.id === step.id;
            return (
              <div
                key={step.id}
                data-node-id={step.id}
                data-phase={failed ? "failed" : phase}
                className={cn(
                  "absolute select-none",
                  dragged &&
                    "z-20 rounded-xl shadow-[0_8px_24px_rgba(20,20,30,0.18)]",
                )}
                style={{
                  ...place,
                  ...(dragged
                    ? { transform: `translateY(${drag.offset}px)` }
                    : {}),
                }}
                {...editing.dragHandlers({
                  id: step.id,
                  lane: stepLane,
                  index,
                })}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Select step ${number}: ${nodeTitle(step)}`}
                  title="Click to edit · drag to reorder · Alt+↑/↓ to move"
                  onClick={() => onSelectStep?.(step.id)}
                  onKeyDown={editing.onStepKeyDown(step.id)}
                  className={cn(
                    className,
                    "h-full w-full",
                    dragged ? "cursor-grabbing" : "cursor-grab",
                  )}
                  style={doneBorder}
                >
                  {body}
                </button>
                {selected && onDeleteStep && (
                  <button
                    type="button"
                    aria-label={`Remove step ${number}`}
                    title="Remove this step"
                    // Not the start of a drag.
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onDeleteStep(step.id, { confirm: false })}
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted hover:border-cx-rose hover:text-cx-rose"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          }

          const shared = {
            "data-node-id": step.id,
            "data-phase": failed ? "failed" : phase,
            className: cn("absolute", className),
            style: { ...place, ...doneBorder },
          };
          return onSelectStep ? (
            <button
              key={step.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectStep(step.id)}
              {...shared}
            >
              {body}
            </button>
          ) : (
            <div key={step.id} {...shared}>
              {body}
            </div>
          );
        })}

        {dropLine && (
          <div
            aria-hidden
            data-drop-indicator=""
            className="pointer-events-none absolute z-30 h-0.5 rounded-full bg-cx-accent"
            style={{ left: dropLine.left, top: dropLine.top, width: NODE_W }}
          />
        )}

        {canInsert && !drag && (
          <>
            {geometry.zones.map((zone) => plusButton(zone, true))}
            {geometry.discs.map((disc) => plusButton(disc, false))}
          </>
        )}

        {editable && onAddBranch && !drag && (
          <button
            type="button"
            aria-label="Add a parallel branch"
            title="Add a parallel branch"
            onClick={onAddBranch}
            className="absolute z-10 flex h-[22px] items-center rounded-full border border-dashed border-cx-border-strong bg-cx-card px-2 text-xs font-medium text-cx-muted hover:border-cx-accent hover:text-cx-accent"
            style={{
              left: geometry.branchPill.left,
              top: geometry.branchPill.top,
            }}
          >
            + branch
          </button>
        )}

        {openPlus && (
          <div
            className="absolute z-40"
            style={{
              left: Math.max(
                4,
                Math.min(openPlus.x - PICKER_W / 2, width - PICKER_W - 4),
              ),
              top: pickerTop,
              width: PICKER_W,
            }}
          >
            {editing.picker}
          </div>
        )}
      </div>
    </div>
  );
};

export default StepsGraphView;
