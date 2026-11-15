import { useTranslation } from "react-i18next";
import React from "react";
import { CornerRightDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  canSetLaneExit,
  editCapabilities,
  firstNodeOf,
  seqAt,
  type Capability,
  type SeqPath,
} from "../../../lib/blockTree";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { STRUCTURE_TYPE } from "../../../lib/scenarioSteps";
import { stepNumbers } from "../../../lib/stepTree";
import {
  ZOOM_STEP,
  clampZoom,
  fitZoom,
  useElementSize,
  useStoredZoom,
} from "../../../lib/graphZoom";
import {
  END_R,
  GAP,
  NODE_H,
  NODE_W,
  START_R,
  layoutTreeGraph,
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
import { highlightedBy } from "../../../lib/graphIssueMarks";
import {
  boxPhase,
  laneLetter,
  type BoxPhase,
  type StepTreeViewProps,
} from "./stepVisuals";
import EdgeIssueMarker from "./graph/EdgeIssueMarker";
import GraphCards from "./graph/GraphCards";
import GraphEdges from "./graph/GraphEdges";
import GraphLoops from "./graph/GraphLoops";
import GraphToolbar from "./graph/GraphToolbar";
import LaneTags from "./graph/LaneTags";
import PickPanel from "./graph/PickPanel";
import PlusButton from "./graph/PlusButton";
import { PICKER_H, PICKER_W, type Pick, type Point } from "./graph/graphShared";
import { laneTargets, loopTargets } from "./graph/pickTargets";

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
    onSelectLane,
    editable = false,
    onInsertStep,
    onWrapInLoopRange,
    onSetLaneExit,
    highlightIds,
    onDeleteStep,
    onAddLane,
    onRemoveLane,
    onUnwrapLoop,
    loopBounds,
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

  // The canvas: its own scroll container, zoomed by `zoom` (a stored mode:
  // "fit" shows the whole graph).
  const scroller = React.useRef<HTMLDivElement>(null);
  const noCards = cards.length === 0;
  const viewport = useElementSize(scroller, noCards);
  const { mode: zoomMode, setMode: setZoomMode } = useStoredZoom();
  const maxViewH =
    typeof window === "undefined" ? 0 : Math.floor(window.innerHeight * 0.75);
  const zoom =
    zoomMode === "fit"
      ? fitZoom(geometry.width, geometry.height, viewport.w, maxViewH)
      : zoomMode;

  // The layout is the geometry: a sequence's block centres come from it
  // (on screen: scaled by the zoom, as the pointer is).
  const [pick, setPick] = React.useState<Pick | null>(null);
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<Point | null>(null);
  const [pickNotice, setPickNotice] = React.useState<string | null>(null);
  /** The loop whose bounds editor is open (its header id). */
  const [openBounds, setOpenBounds] = React.useState<string | null>(null);

  const pickTargets = React.useMemo(
    () =>
      pick === null
        ? null
        : pick.kind === "loop"
          ? loopTargets(tree, pick.path, pick.index)
          : laneTargets(tree, pick.path),
    [pick, tree],
  );

  const plusOf = (slot: { lane: SeqPath; index: number }) =>
    [...geometry.discs, ...geometry.zones].find(
      (p) => p.slot.lane === slot.lane && p.slot.index === slot.index,
    );
  const editing = useStepEditing<SeqPath>(
    {
      ...props,
      structure: onWrapInLoopRange
        ? {
            pick: (slot, kind) => {
              if (kind === "loop") {
                const at = plusOf(slot);
                setPickNotice(null);
                setHoverId(null);
                setCursor(null);
                setPick({
                  kind: "loop",
                  path: slot.lane,
                  index: slot.index,
                  origin: { x: at?.x ?? 0, y: at?.y ?? 0 },
                });
              } else {
                const type = STRUCTURE_TYPE[kind];
                if (type) onInsertStep?.(slot.lane, slot.index, type);
              }
            },
            refusals: (slot) => {
              const targets = loopTargets(tree, slot.lane, slot.index);
              const all = [...targets.values()];
              if (all.some((x) => x.cap.ok)) return {};
              const first = all.find((x) => !x.cap.ok)?.cap;
              return {
                loop: t(
                  first && !first.ok
                    ? first.reason
                    : "scenarioRun.pick.noTarget",
                ),
              };
            },
          }
        : undefined,
    },
    (lane) => (geometry.centres.get(lane) ?? []).map((c) => c * zoom),
  );
  const { drag } = editing;

  /** Each lane of a switch / choice that can continue at a later step: the
   *  connect arrow stands beside its `+` at the lane's end. */
  const laneConnects = React.useMemo(() => {
    if (!editable) return [];
    const out: { path: SeqPath; lane: string; x: number; y: number }[] = [];
    for (const tag of geometry.tags) {
      const fork = tree.nodePath.get(tag.forkId);
      const parent = fork ? seqAt(tree, fork.path) : null;
      const block = parent?.blocks[fork?.index ?? -1];
      if (!parent || block?.kind !== "fork" || !fork) continue;
      if (block.forkKind !== "switch" && block.forkKind !== "choice") continue;
      const lane = block.lanes[tag.laneIndex];
      if (!lane) continue;
      const disc = geometry.discs.find(
        (d) =>
          d.slot.lane === lane.body.path &&
          d.slot.index === lane.body.blocks.length,
      );
      if (!disc) continue;
      const later = parent.blocks.slice(fork.index + 1);
      if (
        !later.some(
          (b) => canSetLaneExit(tree, lane.body.path, firstNodeOf(b).id).ok,
        )
      ) {
        continue;
      }
      out.push({
        path: lane.body.path,
        lane: laneLetter(tag.laneIndex),
        x: disc.x + 14,
        y: disc.y - 9,
      });
    }
    return out;
  }, [tree, editable, geometry]);

  const cancelPick = React.useCallback(() => {
    setPick(null);
    setHoverId(null);
    setPickNotice(null);
  }, []);
  React.useEffect(() => {
    if (pick === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Before the side panel's own Esc and a picker's.
      event.preventDefault();
      event.stopPropagation();
      cancelPick();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pick, cancelPick]);
  // The tree changed under the pick (an edit elsewhere): it no longer applies.
  React.useEffect(() => {
    setPick(null);
  }, [tree]);

  /** Click on a step while picking. */
  const commitPick = (id: string) => {
    const target = pickTargets?.get(id);
    if (!pick || !target) {
      setPickNotice(
        t(
          pick?.kind === "lane"
            ? "scenarioRun.pick.notLater"
            : "scenarioRun.pick.notHere",
        ),
      );
      return;
    }
    if (!target.cap.ok) {
      setPickNotice(t(target.cap.reason));
      return;
    }
    if (pick.kind === "loop") {
      const lane = seqAt(tree, pick.path);
      const from =
        lane?.blocks.findIndex((b) => firstNodeOf(b).id === id) ?? -1;
      if (from >= 0) onWrapInLoopRange?.(pick.path, from, pick.index - 1);
    } else {
      onSetLaneExit?.(pick.path, id);
    }
    cancelPick();
  };

  /** Canvas coordinates of a pointer event (the canvas is scaled by `zoom`
   *  and may be scrolled: its own rect accounts for both). */
  const canvasPoint = (event: React.PointerEvent): Point => {
    const rect = editing.rootRef.current?.getBoundingClientRect();
    return rect
      ? {
          x: (event.clientX - rect.left) / zoom,
          y: (event.clientY - rect.top) / zoom,
        }
      : { x: 0, y: 0 };
  };

  /** The box around the cards of `ids`, padded. */
  const rangeBox = (ids: readonly string[] | undefined) => {
    const set = new Set(ids ?? []);
    const hit = cards.filter((c) => set.has(c.node.id));
    if (hit.length === 0) return null;
    const pad = 10;
    const x0 = Math.min(...hit.map((c) => c.x - NODE_W / 2)) - pad;
    const x1 = Math.max(...hit.map((c) => c.x + NODE_W / 2)) + pad;
    const y0 = Math.min(...hit.map((c) => c.y)) - pad;
    const y1 = Math.max(...hit.map((c) => c.y + NODE_H)) + pad;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  // A graph wider than its column opens on its trunk, the column everything
  // hangs from, instead of the left edge where the trunk may be cut off; the
  // lanes either side are a scroll away.
  const trunkX = cards[0]?.x ?? null;
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || trunkX === null || el.clientWidth === 0) return;
    if (el.scrollLeft === 0 && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = Math.max(0, trunkX * zoom - el.clientWidth / 2);
    }
    // Once per tree: a zoom change keeps where the reader is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trunkX, viewport.w > 0]);

  // Ctrl / Cmd + wheel zooms (a plain wheel scrolls). A native listener: the
  // browser's own page zoom has to be prevented, which React's passive
  // wheel handler cannot.
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoomMode(
        clampZoom(
          event.deltaY < 0
            ? zoomRef.current * ZOOM_STEP
            : zoomRef.current / ZOOM_STEP,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoomMode, noCards]);

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

  const allPaths = [...paths, ...geometry.loops.flatMap((loop) => loop.arcs)];

  const canvasW = Math.max(width, openPlus ? PICKER_W + 8 : 0);

  return (
    <div data-graph-canvas="">
      <GraphToolbar zoom={zoom} zoomMode={zoomMode} setZoomMode={setZoomMode} />
      {pick && pickTargets && (
        <PickPanel
          pick={pick}
          pickTargets={pickTargets}
          pickNotice={pickNotice}
          cards={cards}
          numbers={numbers}
          cancelPick={cancelPick}
          commitPick={commitPick}
          setHoverId={setHoverId}
        />
      )}
      {/* The scroll container is the canvas: it never draws under the side
          panel, and scrolls both ways. */}
      <div
        ref={scroller}
        data-testid="graph-scroll"
        className="overflow-auto rounded-[10px]"
        style={{ maxHeight: "75vh" }}
      >
        <div
          style={{
            width: Math.ceil(canvasW * zoom),
            height: Math.ceil(height * zoom),
          }}
        >
          <div
            ref={editing.rootRef}
            onPointerMove={
              pickTargets ? (e) => setCursor(canvasPoint(e)) : undefined
            }
            // Empty canvas while picking: cancel (a step click commits).
            onClick={
              pickTargets
                ? (e) => {
                    if (!(e.target as HTMLElement).closest("[data-node-id]")) {
                      cancelPick();
                    }
                  }
                : undefined
            }
            data-picking={pick?.kind}
            className={cn("relative", pickTargets && "cursor-crosshair")}
            style={{
              width: canvasW,
              height,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <GraphEdges
              geometry={geometry}
              width={width}
              height={height}
              phaseOf={phaseOf}
              edgeIssueProps={edgeIssueProps}
            />

            {(() => {
              // The steps the pointer is over while picking, or the ones the
              // inspector's "Repeat from this step" would repeat.
              const hovered = hoverId ? pickTargets?.get(hoverId) : undefined;
              const ids = hovered?.cap.ok ? hovered.ids : highlightIds;
              const box = rangeBox(ids);
              if (!box) return null;
              return (
                <div
                  aria-hidden
                  data-range-highlight={hovered?.cap.ok ? "pick" : "hint"}
                  className="pointer-events-none absolute z-[1] rounded-2xl border-2 border-dashed border-cx-purple bg-cx-purple/10"
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.w,
                    height: box.h,
                  }}
                />
              );
            })()}
            {pick && (
              <svg
                aria-hidden
                width={width}
                height={height}
                data-pick-arrow=""
                className="pointer-events-none absolute inset-0 z-30"
              >
                <defs>
                  <marker
                    id="graph-pick-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--cx-accent)" />
                  </marker>
                </defs>
                {(() => {
                  const hot = hoverId
                    ? cards.find(
                        (c) =>
                          c.node.id === hoverId &&
                          pickTargets?.get(hoverId)?.cap.ok,
                      )
                    : undefined;
                  // Snapped to the card's side while it is a valid target,
                  // else to the pointer.
                  const end = hot
                    ? { x: hot.x - NODE_W / 2, y: hot.y + NODE_H / 2 }
                    : (cursor ?? pick.origin);
                  const { origin } = pick;
                  const dx = Math.max(40, Math.abs(end.x - origin.x) / 2 + 30);
                  return (
                    <path
                      d={`M ${origin.x} ${origin.y} C ${origin.x - dx} ${origin.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`}
                      fill="none"
                      stroke="var(--cx-accent)"
                      strokeWidth={2}
                      strokeDasharray={hot ? undefined : "6 4"}
                      markerEnd="url(#graph-pick-arrow)"
                    />
                  );
                })()}
              </svg>
            )}

            <GraphLoops
              geometry={geometry}
              height={height}
              dragging={!!drag}
              openBounds={openBounds}
              setOpenBounds={setOpenBounds}
              unwrapCaps={caps?.unwrap}
              loopBounds={loopBounds}
              onUnwrapLoop={onUnwrapLoop}
            />

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

            <LaneTags
              geometry={geometry}
              editable={editable}
              dragging={!!drag}
              laneCaps={caps?.lane}
              numbers={numbers}
              capTitle={capTitle}
              onRemoveLane={onRemoveLane}
              onSelectLane={onSelectLane}
            />

            <GraphCards
              cards={cards}
              phaseOf={phaseOf}
              state={state}
              currentNodeId={currentNodeId}
              selectedStepId={selectedStepId}
              live={live}
              stepIssues={stepIssues}
              numbers={numbers}
              editable={editable}
              editing={editing}
              drag={drag}
              zoom={zoom}
              pick={pick}
              pickTargets={pickTargets}
              hoverId={hoverId}
              setHoverId={setHoverId}
              commitPick={commitPick}
              onSelectStep={onSelectStep}
              onDeleteStep={onDeleteStep}
            />

            {dropLine && (
              <div
                aria-hidden
                data-drop-indicator=""
                className="pointer-events-none absolute z-30 h-0.5 rounded-full bg-cx-accent"
                style={{
                  left: dropLine.left,
                  top: dropLine.top,
                  width: NODE_W,
                }}
              />
            )}

            {canInsert && !drag && !pick && (
              <>
                {geometry.zones.map((zone) => (
                  <PlusButton
                    key={`zone:${zone.slot.lane}:${zone.slot.index}`}
                    point={zone}
                    hover
                    onOpen={editing.openSlot}
                  />
                ))}
                {geometry.discs.map((disc) => (
                  <PlusButton
                    key={`disc:${disc.slot.lane}:${disc.slot.index}`}
                    point={disc}
                    hover={false}
                    onOpen={editing.openSlot}
                  />
                ))}
              </>
            )}

            {editable &&
              onAddLane &&
              !drag &&
              !pick &&
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

            {editable &&
              onSetLaneExit &&
              !drag &&
              !pick &&
              laneConnects.map((c) => (
                <button
                  key={`connect:${c.path}`}
                  type="button"
                  data-lane-connect={c.path}
                  aria-label={t("scenarioRun.connectLane", { lane: c.lane })}
                  title={t("scenarioRun.connectLane", { lane: c.lane })}
                  onClick={() => {
                    setPickNotice(null);
                    setHoverId(null);
                    setCursor(null);
                    setPick({
                      kind: "lane",
                      path: c.path,
                      lane: c.lane,
                      origin: { x: c.x + 9, y: c.y + 9 },
                    });
                  }}
                  className="absolute z-10 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted hover:border-cx-accent hover:text-cx-accent"
                  style={{ left: c.x, top: c.y }}
                >
                  <CornerRightDown className="h-3 w-3" />
                </button>
              ))}

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
      </div>
    </div>
  );
};

export default StepsGraphView;
