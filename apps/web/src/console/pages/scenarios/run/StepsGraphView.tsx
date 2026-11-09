import { useTranslation } from "react-i18next";
import React from "react";
import { LogOut, Plus, Repeat, RepeatOff, X } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import {
  editCapabilities,
  firstNodeOf,
  seqAt,
  type Capability,
  type SeqPath,
} from "../../../lib/blockTree";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { WAIT_STEP_TYPES, stepSummary } from "../../../lib/scenarioSteps";
import { stepNumbers } from "../../../lib/stepTree";
import {
  END_R,
  GAP,
  NODE_H,
  NODE_W,
  START_R,
  TAG_H,
  layoutTreeGraph,
  type GraphPlus,
} from "../../../lib/treeGraphLayout";
import { dropNeighbours } from "../../../lib/useLaneDrag";
import { useStepEditing } from "../edit/stepEditing";
import IssueBadge from "../edit/IssueBadge";
import {
  SEVERITY,
  useMarkCounts,
  useMarkMessages,
  useStepIssues,
} from "../edit/issueMarkUi";
import { highlightedBy, type IssueMark } from "../../../lib/graphIssueMarks";
import StepTile from "./StepTile";
import {
  CURRENT_CARD,
  boxPhase,
  laneLetter,
  laneStyle,
  nodeTitle,
  type BoxPhase,
  type StepTreeViewProps,
} from "./stepVisuals";

const TODO_STROKE = "var(--cx-border-strong)";
const LOOP_STROKE = "var(--cx-purple)";
/** The step picker opened from a `+` (and the room it needs below). */
const PICKER_W = 520;
const PICKER_H = 330;
const WAIT_TYPES: ReadonlySet<string> = new Set(WAIT_STEP_TYPES);

/**
 * The block tree (`recognizeBlockTree`) drawn as connected cards, laid out
 * recursively (`layoutTreeGraph`): a branch point's lanes stand side by
 * side under it, each under a lane tag (letter and condition chip) its
 * curve ends at, and meet again at a merge point below the lowest lane; a
 * loop is a tinted rectangle behind its body with a solid return arc; a
 * jump is a dashed curve; steps nothing reaches stand on the right. Plain
 * SVG and absolutely placed cards, no graph library. It scrolls sideways
 * when wider than its column.
 *
 * `editable` makes it the editor's Graph view: a click selects a card (the
 * selected one gets a ✕), a `+` disc at the end of each sequence and a `+`
 * on hover between two blocks open the step picker, "+ branch" by a branch
 * point (or START) adds a lane, a lane tag's ✕ removes it, a card drags up
 * or down within its sequence, and a focused card takes Alt+ArrowUp/Down
 * and Delete. Every control is enabled from `editCapabilities`.
 */
const StepsGraphView: React.FC<StepTreeViewProps> = (props) => {
  // Subscribes to language changes (the layout builds labels with `t`).
  const { t } = useTranslation();
  const {
    tree,
    currentNodeId,
    state,
    selectedStepId,
    onSelectStep,
    editable = false,
    onInsertStep,
    onDeleteStep,
    onAddLane,
    onRemoveLane,
    onUnwrapLoop,
    issues,
    executedNodeIds,
  } = props;
  const stepIssues = useStepIssues(issues);
  const markCounts = useMarkCounts();
  const markMessages = useMarkMessages();
  const highlight = highlightedBy(issues?.marks, issues?.highlight);
  const edgeMark = (edgeId: string | undefined) =>
    edgeId === undefined ? undefined : issues?.marks.edges.get(edgeId);
  /** A drawn edge with a diagnostic: stroked in its severity's colour
   *  (thicker while its warning line is pointed at). */
  const edgeIssueProps = (edgeId: string | undefined) => {
    const mark = edgeMark(edgeId);
    if (!mark || edgeId === undefined) return null;
    return {
      "data-issue": mark.entries.map((e) => e.code).join(" "),
      stroke: SEVERITY[mark.severity].color,
      strokeWidth: highlight?.edgeIds.includes(edgeId) ? 3 : 2,
    };
  };
  const phaseOf = (id: string): BoxPhase =>
    boxPhase(id, { currentNodeId, executedNodeIds, state });
  // Laid out once per tree / run state, not on every pointer move of a drag.
  const geometry = React.useMemo(
    () =>
      layoutTreeGraph(tree, {
        editable,
        phaseOf: (id) =>
          boxPhase(id, { currentNodeId, executedNodeIds, state }),
      }),
    [tree, editable, currentNodeId, executedNodeIds, state],
  );
  const numbers = React.useMemo(() => stepNumbers(tree), [tree]);
  /** The capabilities the tags, pills and loops show, once per tree. */
  const caps = React.useMemo(() => {
    if (!editable) return null;
    const lane = new Map<string, Capability>();
    for (const tag of geometry.tags) {
      lane.set(
        tag.key,
        editCapabilities(tree, {
          kind: "lane",
          nodeId: tag.forkId,
          laneIndex: tag.laneIndex,
        }).removeLane,
      );
    }
    const addLane = new Map<string, Capability>();
    for (const pill of geometry.pills) {
      addLane.set(
        pill.nodeId,
        editCapabilities(tree, { kind: "node", nodeId: pill.nodeId }).addLane,
      );
    }
    const unwrap = new Map<string, Capability>();
    for (const loop of geometry.loops) {
      unwrap.set(
        loop.headerId,
        editCapabilities(tree, { kind: "node", nodeId: loop.headerId })
          .unwrapLoop,
      );
    }
    return { lane, addLane, unwrap };
  }, [tree, editable, geometry]);
  const { cards, paths, ends } = geometry;

  // The layout is the geometry: a sequence's block centres come from it.
  const editing = useStepEditing<SeqPath>(
    props,
    (lane) => geometry.centres.get(lane) ?? [],
  );
  const { drag } = editing;

  if (!editable && cards.length === 0) {
    return <p className="text-sm text-cx-muted">{t("scenarioRun.noSteps")}</p>;
  }

  const capTitle = (cap: Capability, label: string) =>
    !cap.ok ? t(cap.reason) : cap.note ? `${label} — ${t(cap.note)}` : label;
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

  // The drop line: between the two blocks the dragged card would land
  // between.
  let dropLine: { left: number; top: number } | null = null;
  // Neighbours by block (a loop has no card of its own in its sequence),
  // as the drag's indices count them.
  const seq =
    drag && drag.to !== drag.from ? seqAt(tree, String(drag.lane)) : null;
  if (drag && seq) {
    const ids = seq.blocks.map((b) => firstNodeOf(b).id);
    const { above, below } = dropNeighbours(ids, drag);
    const column = cards.find((c) => c.seqPath === drag.lane);
    /** Block `id`'s top and bottom: its card, or its loop's rectangle. */
    const extent = (id: string) => {
      const block = seq.blocks[ids.indexOf(id)];
      const loop =
        block?.kind === "loop"
          ? geometry.loops.find((l) => l.headerId === block.headerId)
          : undefined;
      if (loop) return { top: loop.rect.y, bottom: loop.rect.y + loop.rect.h };
      const card = cards.find((c) => c.node.id === id);
      return card ? { top: card.y, bottom: card.y + NODE_H } : null;
    };
    const at = extent(below ?? above ?? "");
    if (column && at) {
      dropLine = {
        left: column.x - NODE_W / 2,
        top: below ? at.top - GAP / 2 - 1 : at.bottom + GAP / 2 - 1,
      };
    }
  }

  const plusButton = (point: GraphPlus, hover: boolean) => (
    <div
      key={`${hover ? "zone" : "disc"}:${point.slot.lane}:${point.slot.index}`}
      // A hover zone covers the gap above a block; a disc stands on its own.
      className={cn(
        "absolute z-10 flex items-center justify-center",
        hover && "group/insert",
      )}
      style={
        hover
          ? {
              left: point.x - NODE_W / 2,
              top: point.y - GAP / 2,
              width: NODE_W,
              height: GAP,
            }
          : { left: point.x - 9, top: point.y - 9, width: 18, height: 18 }
      }
    >
      <button
        type="button"
        aria-label={point.label}
        title={
          hover ? t("scenarioRun.insertStepHere") : t("scenarioRun.addAStep")
        }
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

  const allPaths = [...paths, ...geometry.loops.flatMap((loop) => loop.arcs)];

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
          <defs>
            <marker
              id="graph-link-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--cx-faint)" />
            </marker>
            <marker
              id="graph-loop-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill={LOOP_STROKE} />
            </marker>
          </defs>
          {geometry.loops.map((loop) => (
            <rect
              key={`rect:${loop.key}`}
              data-graph-loop={loop.headerId}
              x={loop.rect.x}
              y={loop.rect.y}
              width={loop.rect.w}
              height={loop.rect.h}
              rx={14}
              fill={LOOP_STROKE}
              fillOpacity={
                loop.ids.some((id) => phaseOf(id) === "current") ? 0.16 : 0.09
              }
            />
          ))}
          {paths.map((path) => (
            <path
              key={path.key}
              d={path.d}
              data-to={path.to}
              data-edge-id={path.edgeId}
              fill="none"
              strokeWidth={path.done ? 2 : 1.5}
              stroke={path.done ? laneStyle(path.lane).color : TODO_STROKE}
              {...edgeIssueProps(path.edgeId)}
            />
          ))}
          {geometry.loops.flatMap((loop) =>
            loop.arcs.map((arc) => (
              <path
                key={arc.key}
                d={arc.d}
                data-loop-arc={loop.headerId}
                data-edge-id={arc.edgeId}
                fill="none"
                strokeWidth={arc.done ? 2 : 1.75}
                stroke={LOOP_STROKE}
                markerEnd="url(#graph-loop-arrow)"
                {...edgeIssueProps(arc.edgeId)}
              />
            )),
          )}
          {geometry.links.map((link) => (
            <path
              key={link.key}
              d={link.d}
              data-link-from={link.from}
              data-link-to={link.to}
              data-link-role={link.role}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              stroke={laneStyle(link.lane).color}
              strokeOpacity={link.role === "dead" ? 0.45 : 1}
              markerEnd="url(#graph-link-arrow)"
              data-edge-id={link.edgeId}
              {...edgeIssueProps(link.edgeId)}
            />
          ))}
          {geometry.merges.map((m) => (
            <circle
              key={`merge:${m.x}:${m.y}`}
              data-graph-merge=""
              cx={m.x}
              cy={m.y}
              r={3.5}
              fill="var(--cx-faint)"
            />
          ))}
          {geometry.start && (
            <circle
              data-graph-start=""
              cx={geometry.start.x}
              cy={geometry.start.y}
              r={START_R}
              fill="var(--cx-faint)"
            />
          )}
          {ends.map((end) => (
            <circle
              key={`end:${end.x}:${end.y}`}
              data-graph-end=""
              cx={end.x}
              cy={end.y}
              r={END_R}
              fill="var(--cx-card)"
              stroke="var(--cx-faint)"
              strokeWidth={2}
            />
          ))}
        </svg>

        {geometry.loops.map((loop) => {
          const canExit = loop.canExit;
          const header = cards.find((c) => c.node.id === loop.headerId);
          const waits = WAIT_TYPES.has(header?.node.type ?? "");
          const unwrapCap =
            onUnwrapLoop && !drag ? caps?.unwrap.get(loop.headerId) : undefined;
          return (
            // The loop's label, then "Stop repeating" right after it (the
            // label truncates first), all inside the rectangle. The label
            // leaves room after it for a future bound ("×N", "until …").
            <div
              key={`label:${loop.key}`}
              className="absolute flex items-center gap-2 whitespace-nowrap text-xs"
              style={{
                left: loop.label.x,
                top: loop.label.y - 1,
                maxWidth: loop.rect.x + loop.rect.w - loop.label.x - 6,
              }}
            >
              <div
                data-loop-block=""
                data-loop-to={loop.headerId}
                aria-label={t("scenarioRun.loopSteps", {
                  from: loop.from,
                  to: loop.to,
                })}
                title={t(
                  canExit
                    ? "scenarioRun.loopUntilExit"
                    : "scenarioRun.loopUntilRunStops",
                )}
                className="flex min-w-0 items-center gap-1.5 overflow-hidden"
              >
                <Repeat
                  className="h-3.5 w-3.5 shrink-0 text-cx-purple"
                  aria-hidden
                />
                <span className="font-semibold text-cx-purple">
                  {t(
                    canExit
                      ? "scenarioRun.loopRepeat"
                      : "scenarioRun.loopForever",
                  )}
                </span>
                {waits && (
                  <span className="truncate text-cx-muted">
                    · {t("scenarioRun.loopWaitsAt", { n: loop.from })}
                  </span>
                )}
              </div>
              {unwrapCap && (
                <button
                  type="button"
                  data-testid="unwrap-loop"
                  data-loop={loop.headerId}
                  title={
                    unwrapCap.ok
                      ? t("scenarios.editor.unwrapLoopHint")
                      : t(unwrapCap.reason)
                  }
                  disabled={!unwrapCap.ok}
                  onClick={() => onUnwrapLoop?.(loop.headerId)}
                  className="z-10 flex h-[18px] shrink-0 items-center gap-1 rounded border border-cx-purple/40 px-1.5 font-medium text-cx-purple hover:bg-cx-purple/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RepeatOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("scenarios.editor.unwrapLoop")}
                </button>
              )}
            </div>
          );
        })}

        {allPaths.map(({ key, edgeId, mid }) => {
          const mark = edgeMark(edgeId);
          return mark ? (
            <EdgeIssueMarker
              key={`issue:${key}`}
              mark={mark}
              x={mid.x}
              y={mid.y}
              label={markCounts(mark)}
              title={markMessages(mark)}
            />
          ) : null;
        })}
        {geometry.links.map((link) => {
          const mark = edgeMark(link.edgeId);
          return mark ? (
            <EdgeIssueMarker
              key={`issue:${link.key}`}
              mark={mark}
              x={link.mid.x}
              y={link.mid.y}
              label={markCounts(mark)}
              title={markMessages(mark)}
            />
          ) : null;
        })}
        {issues?.marks.start && geometry.start && (
          <IssueBadge
            mark={issues.marks.start}
            className="absolute z-10"
            style={{
              left: geometry.start.x + START_R + 6,
              top: geometry.start.y - 9,
            }}
          />
        )}
        {issues?.marks.end &&
          ends.map((end) => (
            <IssueBadge
              key={`end-issue:${end.x}:${end.y}`}
              mark={issues.marks.end!}
              className="absolute z-10"
              style={{ left: end.x + END_R + 6, top: end.y - 9 }}
            />
          ))}

        {geometry.detached && (
          <div
            data-testid="detached-steps"
            className="absolute whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-cx-muted"
            style={{ left: geometry.detached.x, top: geometry.detached.y }}
            title={t("scenarioRun.tree.unreachedHint")}
          >
            {t("scenarioRun.tree.unreached")}
          </div>
        )}

        {geometry.tags.map((tag) => {
          const removeCap =
            editable && onRemoveLane ? (caps?.lane.get(tag.key) ?? null) : null;
          const removeLabel = t("scenarioRun.tree.removeLane", {
            lane: laneLetter(tag.laneIndex),
          });
          return (
            <div
              key={tag.key}
              data-testid="lane-tag"
              data-lane={tag.laneIndex}
              data-fork={tag.forkId}
              data-dead-lane={tag.dead ? "" : undefined}
              data-leaves-loop={tag.leaves ? "" : undefined}
              title={
                tag.dead
                  ? t("scenarioRun.tree.deadLane")
                  : tag.leaves
                    ? t("scenarioRun.tree.leavesLoop")
                    : undefined
              }
              className={cn(
                "absolute z-[5] flex items-center gap-1.5 rounded-full border bg-cx-card px-1 text-xs",
                tag.dead
                  ? "border-dashed border-cx-border-strong opacity-60"
                  : "border-cx-border",
              )}
              style={{
                left: tag.x - tag.w / 2,
                top: tag.y,
                width: tag.w,
                height: TAG_H,
              }}
            >
              <span
                aria-hidden
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                  laneStyle(tag.laneIndex).letter,
                )}
              >
                {laneLetter(tag.laneIndex)}
              </span>
              <span
                data-lane-condition=""
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-cx-fg2"
              >
                {tag.text}
              </span>
              {tag.leaves && (
                <LogOut
                  className="h-3 w-3 shrink-0 text-cx-purple"
                  aria-hidden
                />
              )}
              <span className="shrink-0 font-mono text-[10px] text-cx-muted">
                {tag.count}
              </span>
              {removeCap && !drag && (
                <button
                  type="button"
                  aria-label={removeLabel}
                  title={capTitle(removeCap, removeLabel)}
                  disabled={!removeCap.ok}
                  onClick={() => onRemoveLane?.(tag.forkId, tag.laneIndex)}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-cx-faint hover:bg-cx-rose/10 hover:text-cx-rose disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cx-faint"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}

        {cards.map(({ node: step, x, y, lane, seqPath, index, isFork }) => {
          const phase = phaseOf(step.id);
          const failed = state === "error" && step.id === currentNodeId;
          const selected = selectedStepId === step.id;
          const marked = stepIssues(step.id);
          const className = cn(
            "flex items-center gap-2 rounded-xl border-[1.5px] bg-cx-card px-2.5 text-left",
            phase === "current" && live
              ? CURRENT_CARD[live]
              : failed
                ? "border-cx-rose ring-4 ring-cx-rose/15"
                : phase !== "done" &&
                  (marked.style ? marked.style.border : "border-cx-border"),
            marked.highlighted && marked.style?.glow,
            selected && "outline outline-2 outline-cx-accent",
          );
          const place: React.CSSProperties = {
            left: x - NODE_W / 2,
            top: y,
            width: NODE_W,
            height: NODE_H,
          };
          // Done cards take their lane's colour (inline: any lane index).
          const doneBorder: React.CSSProperties =
            phase === "done" && !failed
              ? { borderColor: laneStyle(lane).color }
              : {};
          const number = numbers.get(step.id) ?? "";
          const body = (
            <>
              <span className="w-[14px] shrink-0 text-right font-mono text-[10px] text-cx-faint">
                {number}
              </span>
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
              {marked.mark && (
                <IssueBadge
                  mark={marked.mark}
                  className="absolute -top-2.5 right-8"
                />
              )}
              {marked.description}
            </>
          );

          if (editable) {
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
                // A branch point stays where it is.
                {...(isFork
                  ? {}
                  : editing.dragHandlers({
                      id: step.id,
                      lane: seqPath,
                      index,
                    }))}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  data-step-select
                  aria-label={t("scenarioRun.selectStep", {
                    n: number,
                    title: nodeTitle(step),
                  })}
                  title={t("scenarioRun.clickToEdit")}
                  onClick={() => onSelectStep?.(step.id)}
                  onKeyDown={editing.onStepKeyDown(step.id)}
                  {...marked.cardProps}
                  className={cn(
                    className,
                    "relative h-full w-full",
                    isFork
                      ? "cursor-pointer"
                      : dragged
                        ? "cursor-grabbing"
                        : "cursor-grab",
                  )}
                  style={doneBorder}
                >
                  {body}
                </button>
                {selected && onDeleteStep && (
                  <button
                    type="button"
                    aria-label={t("scenarioRun.removeStep", { n: number })}
                    title={t("scenarioRun.removeThisStep")}
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
            ...marked.cardProps,
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

        {editable &&
          onAddLane &&
          !drag &&
          geometry.pills.map((pill) => {
            const cap = caps?.addLane.get(pill.nodeId);
            if (!cap) return null;
            return (
              <button
                key={`pill:${pill.nodeId}`}
                type="button"
                aria-label={pill.label}
                title={capTitle(cap, pill.label)}
                disabled={!cap.ok}
                onClick={() => onAddLane(pill.nodeId)}
                className="absolute z-10 flex h-[22px] items-center rounded-full border border-dashed border-cx-border-strong bg-cx-card px-2 text-xs font-medium text-cx-muted hover:border-cx-accent hover:text-cx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-cx-border-strong disabled:hover:text-cx-muted"
                style={{ left: pill.x, top: pill.y }}
              >
                {t("scenarioRun.branchPill")}
              </button>
            );
          })}

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

/** The marker at the middle of a drawn edge with a diagnostic. */
const EdgeIssueMarker: React.FC<{
  mark: IssueMark;
  x: number;
  y: number;
  label: string;
  title: string;
}> = ({ mark, x, y, label, title }) => {
  const style = SEVERITY[mark.severity];
  const Icon = style.icon;
  return (
    <span
      role="img"
      data-edge-issue={mark.severity}
      aria-label={label}
      title={title}
      className={cn(
        "absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-current bg-cx-card",
        style.text,
      )}
      style={{ left: x - 8, top: y - 8 }}
    >
      <Icon aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
};

export default StepsGraphView;
