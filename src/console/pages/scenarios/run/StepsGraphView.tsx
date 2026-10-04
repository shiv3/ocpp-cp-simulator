import React from "react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import type { ScenarioNode } from "../../../../cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { stepSummary } from "../../../lib/scenarioSteps";
import { layoutSteps } from "../../../lib/stepLayout";
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
const TODO_STROKE = "var(--cx-border-strong)";

interface PlacedNode {
  step: ScenarioNode;
  lane: number;
  top: number;
}

interface GraphPath {
  key: string;
  d: string;
  lane: number;
  /** The target node's id, or `end`. */
  to: string;
  done: boolean;
}

const laneX = (lane: number) => X0 + lane * LANE_W;

/** Straight within a lane; a cubic curve when it moves into another lane. */
function connect(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/**
 * The run's steps drawn as connected cards on a fixed grid: the chain in
 * lane 0, a fork's branches curving into lanes of their own below it (the
 * first branch continues lane 0). Self-contained SVG + absolutely placed
 * cards — no graph library, the layout is the pure `deriveStepLayout`.
 */
const StepsGraphView: React.FC<StepRunViewProps> = (props) => {
  const { layout, currentNodeId, state, selectedStepId, onSelectStep } = props;
  const phaseOf = (id: string): BoxPhase => boxPhase(id, props);
  const travelled = (id: string) => {
    const phase = phaseOf(id);
    return phase === "done" || phase === "current";
  };

  if (layoutSteps(layout).length === 0) {
    return <p className="text-sm text-cx-muted">This scenario has no steps.</p>;
  }

  const placed: PlacedNode[] = [];
  const paths: GraphPath[] = [];
  const ends: Array<{ lane: number; y: number }> = [];
  const tags: Array<{ lane: number; name: string; top: number }> = [];
  const startY = Y0 - CAP_GAP - START_R;

  // The chain: start dot, then lane 0 top to bottom.
  let prevBottom = startY + START_R;
  let prevId: string | null = null;
  layout.main.forEach((step, row) => {
    const top = Y0 + row * ROW_H;
    placed.push({ step, lane: 0, top });
    paths.push({
      key: `${prevId ?? "start"}->${step.id}`,
      d: connect(X0, prevBottom, X0, top),
      lane: 0,
      to: step.id,
      done: travelled(step.id),
    });
    prevBottom = top + NODE_H;
    prevId = step.id;
  });

  const lastTop = (lane: number) =>
    Math.max(...placed.filter((p) => p.lane === lane).map((p) => p.top));

  if (layout.fork) {
    // Without a main chain the fork is START itself: branches leave the dot.
    const forkTop =
      layout.main.length > 0
        ? Y0 + (layout.main.length - 1) * ROW_H
        : Y0 - ROW_H;
    const forkBottom = prevBottom;
    const firstTop = forkTop + BRANCH_DROP;
    layout.fork.branches.forEach((branch, lane) => {
      tags.push({ lane, name: branch.name, top: firstTop - 26 });
      let bottom = forkBottom;
      let fromX = X0;
      branch.steps.forEach((step, row) => {
        const top = firstTop + row * ROW_H;
        placed.push({ step, lane, top });
        paths.push({
          key: `${row === 0 ? (prevId ?? "start") : branch.steps[row - 1].id}->${step.id}`,
          d: connect(fromX, bottom, laneX(lane), top),
          lane,
          to: step.id,
          done: travelled(step.id),
        });
        bottom = top + NODE_H;
        fromX = laneX(lane);
      });
      const last = branch.steps[branch.steps.length - 1];
      const endY = (last ? bottom : firstTop) + CAP_GAP + END_R;
      ends.push({ lane, y: endY });
      paths.push({
        key: `${last?.id ?? prevId ?? "start"}->end-${lane}`,
        d: connect(fromX, bottom, laneX(lane), endY - END_R),
        lane,
        to: "end",
        done: last ? phaseOf(last.id) === "done" : false,
      });
    });
  } else {
    const last = layout.main[layout.main.length - 1];
    const endY = lastTop(0) + NODE_H + CAP_GAP + END_R;
    ends.push({ lane: 0, y: endY });
    paths.push({
      key: `${last.id}->end`,
      d: connect(X0, prevBottom, X0, endY - END_R),
      lane: 0,
      to: "end",
      done: phaseOf(last.id) === "done",
    });
  }

  const laneCount = Math.max(1, layout.fork?.branches.length ?? 1);
  const width = X0 + LANE_W * (laneCount - 0.5);
  const height = Math.max(...ends.map((e) => e.y)) + END_R + 16;
  const live = state !== undefined && isLiveRunState(state) ? state : null;

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height }}>
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

        {placed.map(({ step, lane, top }) => {
          const phase = phaseOf(step.id);
          const failed = state === "error" && step.id === currentNodeId;
          const selected = selectedStepId === step.id;
          const className = cn(
            "absolute flex items-center gap-2 rounded-xl border-[1.5px] bg-cx-card px-2.5 text-left",
            phase === "current" && live
              ? CURRENT_CARD[live]
              : failed
                ? "border-cx-rose ring-4 ring-cx-rose/15"
                : phase !== "done" && "border-cx-border",
            selected && "outline outline-2 outline-cx-accent",
          );
          const style: React.CSSProperties = {
            left: laneX(lane) - NODE_W / 2,
            top,
            width: NODE_W,
            height: NODE_H,
            // Done cards take their lane's colour (inline: any lane index).
            ...(phase === "done" && !failed
              ? { borderColor: laneStyle(lane).color }
              : {}),
          };
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
          const shared = {
            "data-node-id": step.id,
            "data-phase": failed ? "failed" : phase,
            className,
            style,
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
      </div>
    </div>
  );
};

export default StepsGraphView;
