import { useTranslation } from "react-i18next";
import React from "react";
import { CornerDownRight, Repeat } from "lucide-react";

import { cn } from "@/lib/utils";
import { type ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  editCapabilities,
  firstNodeOf,
  treeNodes,
  type Block,
  type Capability,
  type ForkBlock,
  type Lane,
  type Seq,
} from "../../../lib/blockTree";
import { LogOut, X } from "lucide-react";
import {
  conditionText,
  forkSummary,
  isDeadLane,
  lanesLeavingLoop,
  linkOf,
  stepNumbers,
  treeSteps,
} from "../../../lib/stepTree";
import { dropNeighbours } from "../../../lib/useLaneDrag";
import { useStepIssues } from "../edit/issueMarkUi";
import InsertZone from "./steps/InsertZone";
import LaneChip from "./steps/LaneChip";
import LoopBlock from "./steps/LoopBlock";
import MergeFooter from "./steps/MergeFooter";
import PendingLoop from "./steps/PendingLoop";
import StepBox, { type StepBoxEditing } from "./steps/StepBox";
import {
  EXIT_TYPES,
  FORK_ICONS,
  WAIT_TYPES,
  blockKey,
  type LeavingLane,
  type SeqContext,
} from "./steps/stepsShared";
import { useStepsEditActions } from "./steps/useStepsEditActions";
import { boxPhase, laneLetter, type StepTreeViewProps } from "./stepVisuals";

export type { StepTreeViewProps } from "./stepVisuals";

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
    onSelectLane,
    editable = false,
    onInsertStep,
    onInsertStepIntoLoop,
    onAddLane,
    onRemoveLane,
    onUnwrapLoop,
    issues,
  } = props;

  const { t } = useTranslation();
  const stepIssues = useStepIssues(issues);
  const {
    pending,
    pendingPicker,
    setPendingPicker,
    setPendingLoop,
    dropNotice,
    editing,
    dragState,
    drag,
    crossTarget,
    crossCap,
  } = useStepsEditActions(props);

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
    if (
      drag &&
      !crossTarget &&
      drag.path === seq.path &&
      drag.target &&
      drag.target.index !== drag.index
    ) {
      const ids = seq.blocks.map((b) => firstNodeOf(b).id);
      const { above, below } = dropNeighbours(ids, {
        id: drag.id,
        to: drag.target.index,
      });
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
        ranged={props.highlightIds?.includes(step.id)}
        marked={stepIssues(step.id)}
        editing={
          editable
            ? {
                // A branch point stays where it is: no grab handle.
                dragHandlers: head
                  ? undefined
                  : dragState.handlers({
                      id: step.id,
                      path: seq.path,
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

  /** The line where a cross-sequence drop would land (rose: refused). */
  const crossLine = (seq: Seq, i: number) =>
    crossTarget &&
    !crossTarget.loop &&
    crossTarget.path === seq.path &&
    crossTarget.index === i ? (
      <li
        key={`drop-${i}`}
        aria-hidden
        data-drop-indicator=""
        data-drop-refused={crossCap && !crossCap.ok ? "" : undefined}
        className={cn(
          "pointer-events-none h-0.5 rounded-full",
          crossCap && !crossCap.ok ? "bg-cx-rose" : "bg-cx-accent",
        )}
      />
    ) : null;

  const renderPending = (seq: Seq, index: number) => {
    if (!pending || pending.path !== seq.path || pending.index !== index) {
      return null;
    }
    return (
      <PendingLoop
        key="pending-loop"
        seq={seq}
        pending={pending}
        tree={tree}
        crossTarget={crossTarget}
        crossCap={crossCap}
        pendingPicker={pendingPicker}
        setPendingPicker={setPendingPicker}
        setPendingLoop={setPendingLoop}
        onInsertStepIntoLoop={onInsertStepIntoLoop}
      />
    );
  };

  const renderSeq = (
    seq: Seq,
    ctx: SeqContext,
    laneLabel?: string,
  ): React.ReactNode => {
    const empty = seq.blocks.length === 0 && seq.path !== "root";
    const emptyHot =
      crossTarget && !crossTarget.loop && crossTarget.path === seq.path;
    return (
      <>
        <ol
          data-lane-list={seq.path}
          className={canInsert ? undefined : "space-y-1.5"}
        >
          {seq.blocks.map((block, i) => (
            <React.Fragment key={blockKey(block)}>
              {renderPending(seq, i)}
              {crossLine(seq, i)}
              {(i > 0 || seq.path !== "root") && gap(seq, i)}
              {block.kind === "step"
                ? renderBox(block.node, seq, i, ctx)
                : block.kind === "loop"
                  ? renderLoop(block, i, ctx)
                  : renderFork(block, seq, i, ctx)}
            </React.Fragment>
          ))}
          {crossLine(seq, seq.blocks.length)}
          {renderPending(seq, seq.blocks.length)}
        </ol>
        {empty && editable && (
          <p
            data-drop-empty={seq.path}
            className={cn(
              "rounded-[10px] border border-dashed px-3 py-2 text-xs",
              emptyHot
                ? crossCap && !crossCap.ok
                  ? "border-cx-rose bg-cx-rose/10 text-cx-rose"
                  : "border-cx-accent bg-cx-accent/10 text-cx-fg2"
                : "border-cx-border-strong text-cx-muted",
            )}
          >
            {t("scenarioRun.emptyLaneHint")}
          </p>
        )}
        {exitNote(seq)}
        {pending?.path === seq.path && pending.index === seq.blocks.length
          ? null
          : addSlot(seq, laneLabel)}
      </>
    );
  };

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
          loop={loop}
          bounds={editable ? props.loopBounds : undefined}
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
          <LaneChip
            laneIndex={laneIndex}
            chip={chip}
            open={{ forkId: fork.node.id, condition: lane.condition }}
            number={number}
            onSelectLane={onSelectLane}
          />
        </div>
        {renderSeq(lane.body, ctx, chip)}
      </li>
    );
  };

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
          <MergeFooter
            fork={fork}
            loopHeader={ctx.loopHeader}
            number={number}
          />
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
          <LaneChip
            laneIndex={li}
            chip={chip}
            open={{ forkId: fork.node.id, condition: lane.condition }}
            number={number}
            onSelectLane={onSelectLane}
          />
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
      {(dropNotice || (crossCap && !crossCap.ok)) && (
        <p
          role="status"
          data-drop-refusal=""
          className="mb-2 rounded-md bg-cx-rose/10 px-2.5 py-1.5 text-xs text-cx-rose"
        >
          {crossCap && !crossCap.ok
            ? t("scenarioRun.dropRefused", { reason: t(crossCap.reason) })
            : dropNotice}
        </p>
      )}
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
