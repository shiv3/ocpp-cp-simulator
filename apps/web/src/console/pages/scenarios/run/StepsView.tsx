import { useTranslation } from "react-i18next";
import React from "react";
import {
  ArrowDown,
  Check,
  CornerDownRight,
  CornerLeftUp,
  GitBranch,
  GitMerge,
  GripVertical,
  LogOut,
  Plus,
  Repeat,
  RepeatOff,
  Shuffle,
  Split,
  Timer,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../components/RunStatePill";
import {
  ScenarioNodeType,
  type ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  editCapabilities,
  firstNodeOf,
  type Block,
  type Capability,
  type ForkBlock,
  type ForkKind,
  type Lane,
  type Seq,
  type SeqPath,
  treeNodes,
} from "../../../lib/blockTree";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { WAIT_STEP_TYPES, stepSummary } from "../../../lib/scenarioSteps";
import {
  conditionText,
  forkSummary,
  isDeadLane,
  lanesLeavingLoop,
  linkOf,
  stepNumbers,
  treeSteps,
} from "../../../lib/stepTree";
import {
  dropNeighbours,
  type LaneDragHandlers,
} from "../../../lib/useLaneDrag";
import type { ScenarioRunState } from "../../../lib/useScenarioRun";
import { useStepEditing } from "../edit/stepEditing";
import IssueBadge from "../edit/IssueBadge";
import { useStepIssues } from "../edit/issueMarkUi";
import StepTile from "./StepTile";
import {
  CURRENT_RING,
  boxPhase,
  laneLetter,
  laneStyle,
  nodeTitle,
  type BoxPhase,
  type StepTreeViewProps,
} from "./stepVisuals";

export type { StepTreeViewProps } from "./stepVisuals";

/** The editor's extras on a box: drag, the keyboard, the drop line. */
interface StepBoxEditing {
  /** Absent: the box cannot be dragged (a branch point). */
  dragHandlers?: LaneDragHandlers;
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
  /** The step's diagnostics (`useStepIssues`). */
  marked?: ReturnType<ReturnType<typeof useStepIssues>>;
  /** The element: a list item of its lane, or a `div` heading a branch
   *  point's block. */
  as?: "li" | "div";
  /** The box is block `blockIndex` of its lane (what a drag measures). */
  blockIndex?: number;
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
  marked,
  as: Tag = "li",
  blockIndex,
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
      className={cn(
        (editing || marked?.mark) && "relative",
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

/** The drag reads the blocks where the browser put them: every block of
 *  the sequence (`data-block`), in document order. A fork or a loop is one
 *  block: a step moves only among the blocks of its own sequence. */
function measureBlocks(path: SeqPath, root: HTMLElement | null): number[] {
  const list = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-lane-list]") ?? [],
  ).find((el) => el.dataset.laneList === path);
  return Array.from(list?.children ?? [])
    .filter((el) => el.hasAttribute("data-block"))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
}

/** Steps that wait (a delay or a trigger): a loop starting at one waits
 *  there first on every round. */
const WAIT_TYPES: ReadonlySet<string> = new Set(WAIT_STEP_TYPES);

/** Steps that may end their branch on a run (a switch or choice whose picked
 *  handle has no edge): a loop holding one is not "forever". */
const EXIT_TYPES: ReadonlySet<string> = new Set([
  ScenarioNodeType.SWITCH,
  ScenarioNodeType.CHOICE,
]);

/**
 * A loop drawn as Scratch draws "forever": a C-shaped block whose top arm
 * says it repeats, whose left spine holds the repeated steps (`children`,
 * a list of boxes), and whose bottom arm says where the run goes back to.
 * The back edge is unconditional, so the loop repeats until the run ends,
 * unless a switch or choice inside picks a handle with no edge (`canExit`):
 * then the top arm says "Repeat", not "Repeat forever".
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
  /** A repeated step may end the branch (a switch or choice). */
  canExit: boolean;
  /** A step inside is the run's current step. */
  active: boolean;
  /** The loop is block `blockIndex` of its lane (what a drag measures). */
  blockIndex?: number;
  /** editable: the "Stop repeating" button and whether it applies. */
  unwrap?: { cap: Capability; onClick: () => void };
  children: React.ReactNode;
}> = ({
  target,
  from,
  to,
  waitsFirst,
  canExit,
  active,
  blockIndex,
  unwrap,
  children,
}) => {
  const { t } = useTranslation();
  const labelId = React.useId();
  const tint = active ? "bg-cx-purple/20" : "bg-cx-purple/12";
  return (
    <li
      data-loop-block=""
      data-block={blockIndex}
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
        <span
          id={labelId}
          title={t(
            canExit
              ? "scenarioRun.loopUntilExit"
              : "scenarioRun.loopUntilRunStops",
          )}
          className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-cx-purple"
        >
          <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t(canExit ? "scenarioRun.loopRepeat" : "scenarioRun.loopForever")}
        </span>
        {waitsFirst && (
          <span className="text-cx-muted">
            · {t("scenarioRun.loopWaitsAt", { n: from })}
          </span>
        )}
        {unwrap && (
          <button
            type="button"
            data-testid="unwrap-loop"
            title={
              unwrap.cap.ok
                ? t("scenarios.editor.unwrapLoopHint")
                : t(unwrap.cap.reason)
            }
            disabled={!unwrap.cap.ok}
            onClick={unwrap.onClick}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-cx-purple hover:bg-cx-purple/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RepeatOff className="h-3.5 w-3.5" aria-hidden />
            {t("scenarios.editor.unwrapLoop")}
          </button>
        )}
      </div>
      <div className="flex">
        <div aria-hidden className={cn("w-3 shrink-0", tint)} />
        <div
          role="group"
          aria-labelledby={labelId}
          className="min-w-0 flex-1 py-1.5 pl-1.5"
        >
          {children}
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

const FORK_ICONS: Record<
  ForkKind,
  React.ComponentType<{ className?: string }>
> = {
  start: Split,
  parallel: Split,
  switch: GitBranch,
  choice: Shuffle,
  timeout: Timer,
  extra: CornerDownRight,
};

/** Where a sequence is drawn: inside which loop's block, if any. */
interface SeqContext {
  /** The first step of the innermost loop around it, or null. */
  loopHeader: string | null;
  /** That loop's lanes that leave it, drawn after its block. */
  exits: LeavingLane[] | null;
  /** The steps drawn inside that loop's block. */
  inLoop: string[] | null;
}

interface LeavingLane {
  fork: ForkBlock;
  lane: Lane;
  laneIndex: number;
}

const blockKey = (block: Block) => `${block.kind}:${firstNodeOf(block).id}`;

/**
 * The scenario's block tree as boxes stacked top to bottom
 * (`recognizeBlockTree`), drawn recursively: steps; a branch point (a START
 * that fans out, a switch, a choice, a step with edges it never follows) as
 * its box, a header saying how it picks, its lanes side by side under a
 * condition chip (lanes that never run muted), and where they meet again;
 * a loop as a C-shaped block around its body (a lane that leaves the loop
 * follows the block); a jump as a note; steps nothing reaches in a section
 * of their own. Boxes are numbered in tree pre-order.
 *
 * `editable` (the editor) adds a `+` between two blocks and "+ Add step" at
 * the end of each sequence, "+ branch" on each branch point and a remove
 * button on each lane, a grab handle to drag a step within its sequence, and
 * the keys of `useStepEditing`. Every control is enabled from
 * `editCapabilities`: a refused one is disabled with the reason as title.
 */
const StepsView: React.FC<StepTreeViewProps> = (props) => {
  const {
    tree,
    currentNodeId,
    state,
    selectedStepId,
    onSelectStep,
    editable = false,
    onInsertStep,
    onAddLane,
    onRemoveLane,
    onUnwrapLoop,
    issues,
  } = props;

  const { t } = useTranslation();
  const stepIssues = useStepIssues(issues);
  const editing = useStepEditing<SeqPath>(props, measureBlocks);
  const { drag } = editing;
  const steps = React.useMemo(() => treeSteps(tree), [tree]);
  const numbers = React.useMemo(() => stepNumbers(tree), [tree]);
  const number = (id: string) => numbers.get(id) ?? null;
  const typeOf = (id: string) => steps.find((s) => s.id === id)?.type ?? "";

  if (!editable && steps.length === 0) {
    return <p className="text-sm text-cx-muted">{t("scenarioRun.noSteps")}</p>;
  }

  const canInsert = editable && onInsertStep !== undefined;
  /** A control's title: the reason it is refused, else its label (with
   *  the note an operation carries). */
  const capTitle = (cap: Capability, label: string) =>
    !cap.ok ? t(cap.reason) : cap.note ? `${label} — ${t(cap.note)}` : label;
  const slotCap = (seq: Seq, index: number) =>
    editCapabilities(tree, { kind: "slot", path: seq.path, index }).insertStep;

  const renderBox = (
    step: ScenarioNode,
    seq: Seq,
    index: number,
    ctx: SeqContext,
    head = false,
  ) => {
    ctx.inLoop?.push(step.id);
    let dropLine: StepBoxEditing["dropLine"] = null;
    if (drag && drag.lane === seq.path && drag.to !== drag.from) {
      const ids = seq.blocks.map((b) => firstNodeOf(b).id);
      const { above, below } = dropNeighbours(ids, drag);
      if (below === step.id) dropLine = "above";
      else if (below === null && above === step.id) dropLine = "below";
    }
    return (
      <StepBox
        key={step.id}
        as={head ? "div" : "li"}
        blockIndex={head ? undefined : index}
        step={step}
        index={number(step.id)}
        phase={boxPhase(step.id, props)}
        failed={state === "error" && step.id === currentNodeId}
        state={state}
        selected={selectedStepId === step.id}
        onSelect={onSelectStep}
        marked={stepIssues(step.id)}
        editing={
          editable
            ? {
                // A branch point stays where it is: no grab handle.
                dragHandlers: head
                  ? undefined
                  : editing.dragHandlers({
                      id: step.id,
                      lane: seq.path,
                      index,
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

  /** The gap before block `i` of `seq`: the insert zone, or the open
   *  picker. A slot no step can go to has none. */
  const gap = (seq: Seq, i: number) => {
    if (!canInsert) return null;
    if (editing.isSlotOpen(seq.path, i)) {
      return (
        <li key={`gap-${i}`} className="py-1.5">
          {editing.picker}
        </li>
      );
    }
    if (drag || !slotCap(seq, i).ok) {
      return <li key={`gap-${i}`} aria-hidden className="h-1.5" />;
    }
    const label =
      i === 0
        ? t("scenarioRun.tree.insertAtTop", {
            n: number(firstNodeOf(seq.blocks[0]).id) ?? "",
          })
        : t("scenarioRun.insertBetween", {
            from: number(firstNodeOf(seq.blocks[i - 1]).id) ?? "",
            to: number(firstNodeOf(seq.blocks[i]).id) ?? "",
          });
    return (
      <InsertZone
        key={`gap-${i}`}
        label={label}
        onOpen={() => editing.openSlot(seq.path, i)}
      />
    );
  };

  /** "+ Add step" at the end of `seq` (disabled with the reason when no
   *  step can go there; left out under a block every path of which ends on
   *  its own: the sequences inside it have their own). */
  const addSlot = (seq: Seq, laneLabel?: string) => {
    if (!canInsert) return null;
    const n = seq.blocks.length;
    if (editing.isSlotOpen(seq.path, n)) {
      return <div className="mt-1.5">{editing.picker}</div>;
    }
    const cap = slotCap(seq, n);
    if (
      !cap.ok &&
      n > 0 &&
      cap.reason === "scenarios.editor.cannot.afterBlockEnds"
    ) {
      return null;
    }
    const last = seq.blocks[n - 1];
    const label =
      laneLabel !== undefined
        ? t("scenarioRun.addToBranch", { name: laneLabel })
        : last && last.kind !== "step"
          ? t("scenarioRun.tree.addAfterBlock", {
              n: number(firstNodeOf(last).id) ?? "",
            })
          : undefined;
    return (
      <button
        type="button"
        aria-label={label}
        title={cap.ok ? undefined : t(cap.reason)}
        disabled={!cap.ok}
        onClick={() => editing.openSlot(seq.path, n)}
        className="mt-1.5 w-full rounded-[10px] border border-dashed border-cx-border-strong py-2 text-[13px] font-medium text-cx-muted hover:text-cx-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-cx-muted"
      >
        {t("scenarioRun.addStepButton")}
      </button>
    );
  };

  /** How a sequence that jumps elsewhere ends: a one-line note. */
  const exitNote = (seq: Seq) => {
    const exit = seq.exit;
    if (exit.kind !== "link") return null;
    const role = linkOf(tree, exit.edgeId)?.role;
    const n = number(exit.target);
    const back = role === "back";
    const Icon = back ? Repeat : CornerDownRight;
    return (
      <p
        data-link-to={exit.target}
        data-link-role={role}
        className="mt-1.5 flex items-center gap-1.5 text-xs text-cx-muted"
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {n === null
          ? t("scenarioRun.tree.toStart")
          : back
            ? t("scenarioRun.loopBack", { n })
            : t("scenarioRun.joinTo", { n })}
      </p>
    );
  };

  const renderSeq = (
    seq: Seq,
    ctx: SeqContext,
    laneLabel?: string,
  ): React.ReactNode => (
    <>
      <ol
        data-lane-list={seq.path}
        className={canInsert ? undefined : "space-y-1.5"}
      >
        {seq.blocks.map((block, i) => (
          <React.Fragment key={blockKey(block)}>
            {(i > 0 || seq.path !== "root") && gap(seq, i)}
            {block.kind === "step"
              ? renderBox(block.node, seq, i, ctx)
              : block.kind === "loop"
                ? renderLoop(block, i, ctx)
                : renderFork(block, seq, i, ctx)}
          </React.Fragment>
        ))}
      </ol>
      {exitNote(seq)}
      {addSlot(seq, laneLabel)}
    </>
  );

  const renderLoop = (
    loop: Extract<Block, { kind: "loop" }>,
    i: number,
    ctx: SeqContext,
  ) => {
    const inner: SeqContext = {
      loopHeader: loop.headerId,
      exits: [],
      inLoop: [],
    };
    const body = renderSeq(loop.body, inner);
    const inside = inner.inLoop ?? [];
    ctx.inLoop?.push(...inside);
    const repeated = inside
      .map((id) => number(id))
      .filter((n): n is number => n !== null);
    const from = number(loop.headerId) ?? 0;
    return (
      <>
        <LoopBlock
          blockIndex={i}
          target={loop.headerId}
          from={from}
          to={Math.max(from, ...repeated)}
          waitsFirst={WAIT_TYPES.has(typeOf(loop.headerId))}
          canExit={
            (inner.exits?.length ?? 0) > 0 ||
            inside.some((id) => EXIT_TYPES.has(typeOf(id)))
          }
          active={inside.some((id) => boxPhase(id, props) === "current")}
          unwrap={
            editable && onUnwrapLoop
              ? {
                  cap: editCapabilities(tree, {
                    kind: "node",
                    nodeId: loop.headerId,
                  }).unwrapLoop,
                  onClick: () => onUnwrapLoop(loop.headerId),
                }
              : undefined
          }
        >
          {body}
        </LoopBlock>
        {inner.exits?.map((exit) => renderLeaving(exit, ctx))}
      </>
    );
  };

  /** A lane that leaves a loop, after the loop's block: its steps run once,
   *  when the loop is left. */
  const renderLeaving = (
    { fork, lane, laneIndex }: LeavingLane,
    ctx: SeqContext,
  ) => {
    const chip = conditionText(lane.condition, fork);
    return (
      <li
        key={`exit:${lane.body.path}`}
        data-loop-exit={fork.node.id}
        data-lane-path={lane.body.path}
        className="mt-1.5 border-l-2 border-dashed border-cx-border-strong pl-3"
      >
        <div
          data-testid="lane-tag"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-cx-muted"
        >
          <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t("scenarioRun.tree.afterLeaving", {
              n: number(fork.node.id) ?? "",
            })}
          </span>
          {laneChip(laneIndex, chip)}
        </div>
        {renderSeq(lane.body, ctx, chip)}
      </li>
    );
  };

  const laneChip = (laneIndex: number, chip: string) => (
    <>
      <span
        aria-hidden
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
          laneStyle(laneIndex).letter,
        )}
      >
        {laneLetter(laneIndex)}
      </span>
      <span
        data-lane-condition=""
        title={chip}
        className="min-w-0 truncate rounded-md bg-cx-sub px-1.5 py-0.5 font-mono text-[11px] text-cx-fg2"
      >
        {chip}
      </span>
    </>
  );

  const renderFork = (
    fork: ForkBlock,
    seq: Seq,
    i: number,
    ctx: SeqContext,
  ) => {
    const isStart = fork.forkKind === "start";
    const leaving = lanesLeavingLoop(fork, ctx.loopHeader);
    const Icon = FORK_ICONS[fork.forkKind];
    const addCap =
      editable && onAddLane
        ? editCapabilities(tree, { kind: "node", nodeId: fork.node.id }).addLane
        : null;
    const addLabel = isStart
      ? t("scenarioRun.addParallelBranch")
      : t("scenarioRun.tree.addLaneTo", { n: number(fork.node.id) ?? "" });
    return (
      <li
        key={fork.node.id}
        data-block={i}
        data-fork={fork.node.id}
        data-fork-kind={fork.forkKind}
        className="min-w-0"
      >
        {!isStart && renderBox(fork.node, seq, i, ctx, true)}
        <div
          data-fork-body=""
          className={cn(
            "rounded-[12px] border border-cx-border px-2.5 pb-2.5 pt-2",
            !isStart && "mt-1.5",
          )}
        >
          <div
            data-testid="fork-header"
            className="mb-2 flex min-h-[22px] items-center gap-1.5 text-xs"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-cx-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium text-cx-fg2">
              {forkSummary(fork)}
            </span>
            {addCap && (
              <button
                type="button"
                aria-label={addLabel}
                title={capTitle(addCap, addLabel)}
                disabled={!addCap.ok}
                onClick={() => onAddLane?.(fork.node.id)}
                className="flex h-[22px] shrink-0 items-center rounded-full border border-dashed border-cx-border-strong bg-cx-card px-2 text-xs font-medium text-cx-muted hover:border-cx-accent hover:text-cx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-cx-border-strong disabled:hover:text-cx-muted"
              >
                {t("scenarioRun.branchPill")}
              </button>
            )}
          </div>
          <div
            data-testid="step-branches"
            // Lanes grow to what they hold (a nested branch point is
            // wider than one lane); the view scrolls sideways when wide.
            className="flex gap-3"
          >
            {fork.lanes.map((lane, li) =>
              renderLane(fork, lane, li, leaving.has(li), ctx),
            )}
          </div>
          {mergeFooter(fork, ctx)}
        </div>
      </li>
    );
  };

  const renderLane = (
    fork: ForkBlock,
    lane: Lane,
    li: number,
    leaves: boolean,
    ctx: SeqContext,
  ) => {
    const dead = isDeadLane(lane);
    const chip = conditionText(lane.condition, fork);
    const laneSteps = treeNodes({
      root: lane.body,
      detached: [],
      origin: null,
    });
    const done = laneSteps.filter(
      (s) => boxPhase(s.id, props) === "done",
    ).length;
    const removeCap =
      editable && onRemoveLane
        ? editCapabilities(tree, {
            kind: "lane",
            nodeId: fork.node.id,
            laneIndex: li,
          }).removeLane
        : null;
    const removeLabel = t("scenarioRun.tree.removeLane", {
      lane: laneLetter(li),
    });
    if (leaves) ctx.exits?.push({ fork, lane, laneIndex: li });
    return (
      <div
        key={lane.edgeId}
        data-lane={li}
        data-lane-path={lane.body.path}
        data-dead-lane={dead ? "" : undefined}
        data-leaves-loop={leaves ? "" : undefined}
        title={dead ? t("scenarioRun.tree.deadLane") : undefined}
        className={cn(
          // No min-width of its own: a lane is at least as wide as what it
          // holds (its tag is 230px).
          "flex-1 basis-0",
          dead &&
            "rounded-[10px] border border-dashed border-cx-border-strong p-1.5 opacity-60",
        )}
      >
        <div
          data-testid="lane-tag"
          className="mb-2 flex min-w-[230px] items-center gap-2"
        >
          {laneChip(li, chip)}
          <span className="flex-1" />
          <span className="font-mono text-xs text-cx-muted">
            {state === undefined
              ? laneSteps.length
              : `${done}/${laneSteps.length}`}
          </span>
          {removeCap && (
            <button
              type="button"
              aria-label={removeLabel}
              title={capTitle(removeCap, removeLabel)}
              disabled={!removeCap.ok}
              onClick={() => onRemoveLane?.(fork.node.id, li)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-cx-faint hover:bg-cx-rose/10 hover:text-cx-rose disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cx-faint"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {leaves ? (
          <p className="flex items-center gap-1.5 text-xs text-cx-muted">
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            {t("scenarioRun.tree.leavesLoop")}
          </p>
        ) : (
          renderSeq(lane.body, ctx, chip)
        )}
      </div>
    );
  };

  const mergeFooter = (fork: ForkBlock, ctx: SeqContext) => {
    const merge = fork.merge;
    // Lanes that meet at their loop's first step: the block's back arm
    // says where they go.
    if (!merge || merge.nodeId === ctx.loopHeader) return null;
    if (merge.kind === "join") {
      return (
        <p
          data-join={merge.nodeId}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-cx-sub px-2 py-0.5 text-xs text-cx-fg2"
        >
          <GitMerge className="h-3.5 w-3.5" aria-hidden />
          {t("scenarioRun.tree.join", { mode: merge.mode })}
        </p>
      );
    }
    const n = number(merge.nodeId);
    return (
      <p
        data-merge={merge.nodeId}
        className="mt-2 flex items-center gap-1.5 text-xs text-cx-muted"
      >
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        {n !== null
          ? t("scenarioRun.tree.continuesAt", { n })
          : t("scenarioRun.tree.continuesAtEnd")}
      </p>
    );
  };

  const origin = tree.origin;
  const rootFork = tree.root.blocks[0];
  const startForks =
    rootFork?.kind === "fork" && rootFork.node.id === origin?.id;
  const originCap =
    editable && onAddLane && origin && !startForks
      ? editCapabilities(tree, { kind: "node", nodeId: origin.id }).addLane
      : null;
  const rootCtx: SeqContext = { loopHeader: null, exits: null, inLoop: null };

  return (
    <div ref={editing.rootRef} className="overflow-x-auto">
      {renderSeq(tree.root, rootCtx)}
      {originCap && origin && (
        <button
          type="button"
          title={capTitle(originCap, t("scenarioRun.addParallelBranch"))}
          disabled={!originCap.ok}
          onClick={() => onAddLane?.(origin.id)}
          className="mt-3 text-[13px] font-medium text-cx-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("scenarioRun.addParallelBranchButton")}
        </button>
      )}
      {tree.detached.length > 0 && (
        <section
          data-testid="detached-steps"
          aria-label={t("scenarioRun.tree.unreached")}
          className="mt-4 border-t-2 border-dashed border-cx-border-strong pt-3"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-cx-muted">
            {t("scenarioRun.tree.unreached")}
          </h3>
          <p className="mb-2 text-xs text-cx-muted">
            {t("scenarioRun.tree.unreachedHint")}
          </p>
          {tree.detached.map((seq) => (
            <div key={seq.path} data-detached={seq.path} className="mt-2">
              {renderSeq(seq, rootCtx)}
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

export default StepsView;
