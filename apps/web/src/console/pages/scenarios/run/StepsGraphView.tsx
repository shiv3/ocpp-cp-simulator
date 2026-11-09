import { useTranslation } from "react-i18next";
import React from "react";
import {
  CornerRightDown,
  LogOut,
  Maximize2,
  Minus,
  Plus,
  Repeat,
  RepeatOff,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import {
  canSetLaneExit,
  canWrapInLoop,
  editCapabilities,
  firstNodeOf,
  seqAt,
  treeNodes,
  type Capability,
  type SeqPath,
} from "../../../lib/blockTree";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import {
  STRUCTURE_TYPE,
  WAIT_STEP_TYPES,
  stepSummary,
} from "../../../lib/scenarioSteps";
import { stepNumbers } from "../../../lib/stepTree";
import { LoopBoundsPanel, LoopBoundsSummary } from "./loopBoundsUi";
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
/** Room the bounds editor needs below its loop before it opens upward. */
const BOUNDS_PANEL_H = 300;
/** Scrolls a freshly opened bounds editor into view in the canvas. */
const revealBounds = (el: HTMLElement | null) =>
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
const WAIT_TYPES: ReadonlySet<string> = new Set(WAIT_STEP_TYPES);

/** Picking a target on the canvas: after Repeat from a `+` (the loop goes
 *  back to an earlier step of the lane) or a lane's connect arrow (the lane
 *  continues at a later step). `origin`: where the arrow starts. */
type Pick =
  | { kind: "loop"; path: SeqPath; index: number; origin: Point }
  | {
      kind: "lane";
      path: SeqPath;
      /** Lane letter, for the words. */
      lane: string;
      origin: Point;
    };

interface Point {
  x: number;
  y: number;
}

/** What clicking a step would do while picking: `cap` says whether, `ids`
 *  are the steps the result affects (the range to highlight). */
interface PickTarget {
  cap: Capability;
  ids: string[];
  /** Loop: the numbers of the first and last step the loop would repeat. */
  from?: number;
  to?: number;
}

const idsOf = (blocks: ReadonlyArray<import("../../../lib/blockTree").Block>) =>
  treeNodes({
    root: {
      path: "",
      blocks: [...blocks],
      exit: { kind: "stop", reason: "noEdge" },
    },
    detached: [],
    origin: null,
  }).map((n) => n.id);

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

  /** What each step of the lane would do as the target of the pick. */
  const loopTargets = (path: SeqPath, index: number) => {
    const out = new Map<string, PickTarget>();
    const lane = seqAt(tree, path);
    if (!lane) return out;
    for (let from = 0; from < Math.min(index, lane.blocks.length); from++) {
      out.set(firstNodeOf(lane.blocks[from]).id, {
        cap: canWrapInLoop(tree, path, from, index - 1),
        ids: idsOf(lane.blocks.slice(from, index)),
      });
    }
    return out;
  };
  const laneTargets = (path: SeqPath) => {
    const out = new Map<string, PickTarget>();
    const m = /^(.*)\/(\d+)\/lanes\/\d+$/.exec(path);
    const parent = m ? seqAt(tree, m[1]) : null;
    if (!m || !parent) return out;
    for (let j = Number(m[2]) + 1; j < parent.blocks.length; j++) {
      const id = firstNodeOf(parent.blocks[j]).id;
      out.set(id, {
        cap: canSetLaneExit(tree, path, id),
        // The steps the lane would skip, and the one it continues at.
        ids: idsOf(parent.blocks.slice(Number(m[2]) + 1, j + 1)),
      });
    }
    return out;
  };
  const pickTargets = React.useMemo(
    () =>
      pick === null
        ? null
        : pick.kind === "loop"
          ? loopTargets(pick.path, pick.index)
          : laneTargets(pick.path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              const targets = loopTargets(slot.lane, slot.index);
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

  const canvasW = Math.max(width, openPlus ? PICKER_W + 8 : 0);
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const zoomButton =
    "flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs text-cx-fg2 hover:bg-cx-sub disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div data-graph-canvas="">
      <div
        role="toolbar"
        aria-label={t("scenarioRun.zoom.label")}
        className="mb-1.5 flex items-center justify-end gap-0.5"
      >
        <button
          type="button"
          aria-label={t("scenarioRun.zoom.out")}
          title={t("scenarioRun.zoom.out")}
          disabled={zoom <= 0.25}
          onClick={() => setZoomMode(clampZoom(zoom / ZOOM_STEP))}
          className={zoomButton}
        >
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span
          data-testid="graph-zoom-level"
          aria-live="polite"
          className="w-10 text-center font-mono text-[11px] text-cx-muted"
        >
          {zoomLabel}
        </span>
        <button
          type="button"
          aria-label={t("scenarioRun.zoom.in")}
          title={t("scenarioRun.zoom.in")}
          disabled={zoom >= 2}
          onClick={() => setZoomMode(clampZoom(zoom * ZOOM_STEP))}
          className={zoomButton}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-pressed={zoomMode === "fit"}
          title={t("scenarioRun.zoom.fitHint")}
          onClick={() => setZoomMode("fit")}
          className={cn(zoomButton, zoomMode === "fit" && "bg-cx-sub")}
        >
          <Maximize2 className="mr-1 h-3 w-3" aria-hidden />
          {t("scenarioRun.zoom.fit")}
        </button>
        <button
          type="button"
          aria-pressed={zoomMode === 1}
          title={t("scenarioRun.zoom.resetHint")}
          onClick={() => setZoomMode(1)}
          className={cn(zoomButton, zoomMode === 1 && "bg-cx-sub")}
        >
          100%
        </button>
      </div>
      {pick && pickTargets && (
        <div
          role="group"
          data-pick-panel=""
          aria-label={t(
            pick.kind === "loop"
              ? "scenarioRun.pick.title"
              : "scenarioRun.pick.titleLane",
            { lane: pick.kind === "lane" ? pick.lane : "" },
          )}
          className="mb-1.5 rounded-[10px] border border-cx-accent/40 bg-cx-accent/5 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="flex-1 font-medium text-cx-fg">
              {t(
                pick.kind === "loop"
                  ? "scenarioRun.pick.title"
                  : "scenarioRun.pick.titleLane",
                { lane: pick.kind === "lane" ? pick.lane : "" },
              )}
            </span>
            <button
              type="button"
              onClick={cancelPick}
              className="rounded border border-cx-border-strong px-2 py-0.5 text-cx-fg2 hover:bg-cx-sub"
            >
              {t("scenarioRun.pick.cancel")}
            </button>
          </div>
          <p className="mt-0.5 text-cx-muted">
            {pickNotice ??
              t(
                pick.kind === "loop"
                  ? "scenarioRun.pick.hint"
                  : "scenarioRun.pick.hintLane",
              )}
          </p>
          <ul
            aria-label={t("scenarioRun.pick.listLabel")}
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            {[...pickTargets.entries()].map(([id, target]) => {
              const step = cards.find((c) => c.node.id === id)?.node;
              if (!step) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    data-pick-target={id}
                    disabled={!target.cap.ok}
                    title={target.cap.ok ? undefined : t(target.cap.reason)}
                    onClick={() => commitPick(id)}
                    onFocus={() => setHoverId(id)}
                    onMouseEnter={() => setHoverId(id)}
                    onBlur={() => setHoverId((h) => (h === id ? null : h))}
                    className="rounded-md border border-cx-border-strong bg-cx-card px-2 py-1 text-cx-fg2 hover:border-cx-accent focus-visible:border-cx-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t("scenarioRun.pick.target", {
                      n: numbers.get(id) ?? "",
                      title: nodeTitle(step),
                    })}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
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
                    loop.ids.some((id) => phaseOf(id) === "current")
                      ? 0.16
                      : 0.09
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

            {geometry.loops.map((loop) => {
              const canExit = loop.canExit;
              const boundsOpen = openBounds === loop.headerId;
              const header = cards.find((c) => c.node.id === loop.headerId);
              const waits = WAIT_TYPES.has(header?.node.type ?? "");
              const unwrapCap =
                onUnwrapLoop && !drag
                  ? caps?.unwrap.get(loop.headerId)
                  : undefined;
              // The loop's label (its bounds, for a loop edge), then "Bounds"
              // and "Stop repeating" right after it (the label truncates
              // first), all inside the rectangle; the bounds editor opens
              // below it.
              return (
                <React.Fragment key={`label:${loop.key}`}>
                  <div
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
                      {loop.loopEdge ? (
                        <LoopBoundsSummary
                          loop={loop}
                          className="min-w-0 truncate font-semibold text-cx-purple"
                        />
                      ) : (
                        <span className="min-w-0 truncate font-semibold text-cx-purple">
                          {t(
                            canExit
                              ? "scenarioRun.loopRepeat"
                              : "scenarioRun.loopForever",
                          )}
                        </span>
                      )}
                      {waits && (
                        <span className="min-w-0 shrink-[1000] truncate text-cx-muted">
                          · {t("scenarioRun.loopWaitsAt", { n: loop.from })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="absolute flex items-center gap-2 whitespace-nowrap text-xs"
                    style={{ left: loop.label.x, top: loop.label.y + 21 }}
                  >
                    {loopBounds && !drag && (
                      <button
                        type="button"
                        data-testid="edit-loop-bounds"
                        data-loop={loop.headerId}
                        aria-expanded={boundsOpen}
                        title={t("scenarioRun.loopBounds.editHint")}
                        onClick={() =>
                          setOpenBounds(boundsOpen ? null : loop.headerId)
                        }
                        className="z-10 flex h-[18px] shrink-0 items-center gap-1 rounded border border-cx-purple/40 px-1.5 font-medium text-cx-purple hover:bg-cx-purple/15"
                      >
                        <SlidersHorizontal
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden
                        />
                        {t("scenarioRun.loopBounds.edit")}
                      </button>
                    )}
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
                        <RepeatOff
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden
                        />
                        {t("scenarios.editor.unwrapLoop")}
                      </button>
                    )}
                  </div>
                  {boundsOpen && loopBounds && (
                    <div
                      ref={revealBounds}
                      className="absolute z-20 w-[340px]"
                      style={
                        // Near the canvas bottom: open upward, over the loop.
                        loop.label.y + 22 + BOUNDS_PANEL_H > height
                          ? {
                              left: loop.label.x,
                              bottom: Math.max(0, height - loop.label.y + 4),
                            }
                          : { left: loop.label.x, top: loop.label.y + 44 }
                      }
                    >
                      <LoopBoundsPanel
                        loop={loop}
                        editing={loopBounds}
                        onClose={() => setOpenBounds(null)}
                      />
                    </div>
                  )}
                </React.Fragment>
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
                editable && onRemoveLane
                  ? (caps?.lane.get(tag.key) ?? null)
                  : null;
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
                const pickTarget = pickTargets?.get(step.id);
                const pickState = !pickTargets
                  ? undefined
                  : pickTarget?.cap.ok
                    ? "valid"
                    : "invalid";
                const pickReason = !pickTargets
                  ? undefined
                  : pickTarget
                    ? pickTarget.cap.ok
                      ? undefined
                      : t(pickTarget.cap.reason)
                    : t(
                        pick?.kind === "lane"
                          ? "scenarioRun.pick.notLater"
                          : "scenarioRun.pick.notHere",
                      );
                return (
                  <div
                    key={step.id}
                    data-node-id={step.id}
                    data-phase={failed ? "failed" : phase}
                    data-pick={pickState}
                    title={pickReason}
                    onPointerEnter={
                      pickTargets ? () => setHoverId(step.id) : undefined
                    }
                    onPointerLeave={
                      pickTargets
                        ? () => setHoverId((h) => (h === step.id ? null : h))
                        : undefined
                    }
                    className={cn(
                      "absolute select-none",
                      dragged &&
                        "z-20 rounded-xl shadow-[0_8px_24px_rgba(20,20,30,0.18)]",
                      pickState === "invalid" && "opacity-35",
                      pickState === "valid" &&
                        "z-10 rounded-xl ring-2 ring-cx-accent/50",
                      pickState === "valid" &&
                        hoverId === step.id &&
                        "ring-4 ring-cx-accent",
                    )}
                    style={{
                      ...place,
                      ...(dragged
                        ? { transform: `translateY(${drag.offset / zoom}px)` }
                        : {}),
                    }}
                    // A branch point stays where it is; nothing drags while
                    // a target is being picked.
                    {...(isFork || pickTargets
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
                      onClick={() =>
                        pickTargets
                          ? commitPick(step.id)
                          : onSelectStep?.(step.id)
                      }
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
                    {selected && onDeleteStep && !pickTargets && (
                      <button
                        type="button"
                        aria-label={t("scenarioRun.removeStep", { n: number })}
                        title={t("scenarioRun.removeThisStep")}
                        // Not the start of a drag.
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() =>
                          onDeleteStep(step.id, { confirm: false })
                        }
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
                style={{
                  left: dropLine.left,
                  top: dropLine.top,
                  width: NODE_W,
                }}
              />
            )}

            {canInsert && !drag && !pick && (
              <>
                {geometry.zones.map((zone) => plusButton(zone, true))}
                {geometry.discs.map((disc) => plusButton(disc, false))}
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
