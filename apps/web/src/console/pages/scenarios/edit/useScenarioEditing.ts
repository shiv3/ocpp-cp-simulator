import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AnyScenarioNodeType,
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { requiredSchemaVersion } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import { collectStateKeys } from "../../../../components/scenario/forms/scenarioValue";
import {
  addLane,
  canMoveStep,
  canMoveStepTo,
  canSetLaneExit,
  canSetLoopBounds,
  canWrapInLoop,
  editCapabilities,
  firstNodeOf,
  insertForkBlock,
  insertStep,
  insertStepIntoNewLoop,
  moveStep,
  moveStepTo,
  removeLane,
  removeStep,
  seqAt,
  setLaneExit,
  setLink,
  setLoopBounds,
  treeNodes,
  unwrapLoop,
  wrapInLoop,
  type BlockTree,
  type Capability,
  type SeqPath,
} from "../../../lib/blockTree";
import { updateStepData } from "../../../lib/scenarioSteps";
import type { LoopBoundsEditing } from "../run/loopBoundsUi";

export interface ScenarioEditingInput {
  scenario: ScenarioDefinition | null;
  tree: BlockTree | null;
  numbers: ReadonlyMap<string, number>;
  setScenario: React.Dispatch<React.SetStateAction<ScenarioDefinition | null>>;
  setSelectedStepId: (
    next: string | null | ((prev: string | null) => string | null),
  ) => void;
  setNotice: (notice: string | null) => void;
  setPendingDelete: (nodeId: string | null) => void;
  setPendingLane: (
    lane: { nodeId: string; laneIndex: number; count: number } | null,
  ) => void;
}

/** The editor's structural edits: each goes through the block tree's
 *  operations, says why one is refused, and applies the result. */
export function useScenarioEditing({
  scenario,
  tree,
  numbers,
  setScenario,
  setSelectedStepId,
  setNotice,
  setPendingDelete,
  setPendingLane,
}: ScenarioEditingInput) {
  const { t } = useTranslation();
  /** Applies an edit; an edit that adds a construct newer than the declared
   *  schema version raises the declaration to the version that introduced it
   *  (never lowers it), so the editor's own change is not flagged as newer. */
  const setEdited = (next: ScenarioDefinition) => {
    const version = requiredSchemaVersion(next);
    setScenario(
      version !== next.schemaVersion
        ? { ...next, schemaVersion: version as string }
        : next,
    );
  };

  const handleMetaChange = (patch: Partial<ScenarioDefinition>) => {
    setScenario((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  /** Selects the step a change added (the one id `next` has that the
   *  scenario had not). */
  const applyAndSelectNew = (next: ScenarioDefinition) => {
    if (!scenario) return;
    const before = new Set(scenario.nodes.map((n) => n.id));
    setEdited(next);
    setSelectedStepId(next.nodes.find((n) => !before.has(n.id))?.id ?? null);
  };

  const numberOf = (nodeId: string) => numbers.get(nodeId) ?? "";
  /** Says why an edit asked for is refused (`cap`), or runs it. */
  const unlessRefused = (
    nodeId: string,
    cap: Capability,
    run: () => void,
  ): void => {
    if (cap.ok) {
      setNotice(null);
      run();
      return;
    }
    setNotice(
      t("scenarios.editor.refused", {
        n: numberOf(nodeId),
        reason: t(cap.reason),
      }),
    );
  };

  /** A step type picked for slot `index` of the sequence at `path`: a
   *  switch or choice comes with one lane per case / option. */
  const handleInsertStep = (
    path: SeqPath,
    index: number,
    type: AnyScenarioNodeType,
  ) => {
    if (!scenario || !tree) return;
    const kind =
      type === ScenarioNodeType.SWITCH
        ? "switch"
        : type === ScenarioNodeType.CHOICE
          ? "choice"
          : null;
    applyAndSelectNew(
      kind
        ? insertForkBlock(scenario, tree, path, index, kind)
        : insertStep(scenario, tree, path, index, type),
    );
  };

  /** The steps the inspector's "Repeat from this step" would repeat, shown
   *  in both views while the pointer or focus is on that button. */
  const [rangeHint, setRangeHint] = useState<readonly string[] | null>(null);
  const showRangeOf = (nodeId: string | null) => {
    const place = nodeId && tree ? tree.nodePath.get(nodeId) : undefined;
    const seq = place && tree ? seqAt(tree, place.path) : null;
    if (!place || !seq) {
      setRangeHint(null);
      return;
    }
    setRangeHint(
      treeNodes({
        root: { ...seq, blocks: seq.blocks.slice(place.index) },
        detached: [],
        origin: null,
      }).map((n) => n.id),
    );
  };

  /** Graph view: steps `from`..`to` of the sequence at `path` become a loop. */
  const handleWrapInLoopRange = (path: SeqPath, from: number, to: number) => {
    if (!scenario || !tree) return;
    const cap = canWrapInLoop(tree, path, from, to);
    const first = seqAt(tree, path)?.blocks[from];
    unlessRefused(first ? firstNodeOf(first).id : "", cap, () =>
      setEdited(wrapInLoop(scenario, tree, path, from, to)),
    );
  };

  /** Graph view: a lane continues at a later step. */
  const handleSetLaneExit = (lanePath: SeqPath, target: string) => {
    if (!scenario || !tree) return;
    unlessRefused(target, canSetLaneExit(tree, lanePath, target), () =>
      setEdited(setLaneExit(scenario, tree, lanePath, target)),
    );
  };

  /** The first step of an empty Repeat block: the repeat is written around it. */
  const handleInsertStepIntoLoop = (
    path: SeqPath,
    index: number,
    type: AnyScenarioNodeType,
  ) => {
    if (!scenario || !tree) return;
    applyAndSelectNew(insertStepIntoNewLoop(scenario, tree, path, index, type));
  };

  /** A step dropped in another sequence, or into a new Repeat block. */
  const handleMoveStepTo = (
    nodeId: string,
    path: SeqPath,
    index: number,
    loop: boolean,
  ) => {
    if (!scenario || !tree) return;
    unlessRefused(nodeId, canMoveStepTo(tree, nodeId, path, index, loop), () =>
      setEdited(moveStepTo(scenario, tree, nodeId, path, index, loop)),
    );
  };

  /** Moves a step `delta` places within its sequence. */
  const handleMove = (nodeId: string, delta: number) => {
    if (!scenario || !tree) return;
    const place = tree.nodePath.get(nodeId);
    if (!place) return;
    // Keys and drags alike: a refused move says why.
    unlessRefused(
      nodeId,
      canMoveStep(tree, place.path, place.index, place.index + delta),
      () =>
        setEdited(
          moveStep(
            scenario,
            tree,
            place.path,
            place.index,
            place.index + delta,
          ),
        ),
    );
  };

  const removeCap = (nodeId: string): Capability =>
    tree
      ? editCapabilities(tree, { kind: "node", nodeId }).removeStep
      : { ok: false, reason: "scenarios.editor.cannot.notInTree" };

  const handleDelete = (nodeId: string) => {
    if (!scenario || !tree) return;
    unlessRefused(nodeId, removeCap(nodeId), () => {
      setEdited(removeStep(scenario, tree, nodeId));
      setSelectedStepId((sel) => (sel === nodeId ? null : sel));
    });
    setPendingDelete(null);
  };

  /** The keyboard's Delete asks first (one key away from losing a step);
   *  the ✕ and the inspector's bin are deliberate clicks. */
  const handleDeleteRequest = (
    nodeId: string,
    { confirm }: { confirm: boolean },
  ) => {
    if (!confirm) handleDelete(nodeId);
    else
      unlessRefused(nodeId, removeCap(nodeId), () => setPendingDelete(nodeId));
  };

  const handleAddLane = (nodeId: string) => {
    if (!scenario || !tree) return;
    unlessRefused(
      nodeId,
      editCapabilities(tree, { kind: "node", nodeId }).addLane,
      () => applyAndSelectNew(addLane(scenario, tree, nodeId)),
    );
  };

  const doRemoveLane = (nodeId: string, laneIndex: number) => {
    if (!scenario || !tree) return;
    setPendingLane(null);
    unlessRefused(
      nodeId,
      editCapabilities(tree, { kind: "lane", nodeId, laneIndex }).removeLane,
      () => setEdited(removeLane(scenario, tree, nodeId, laneIndex)),
    );
  };

  /** Removing a lane with steps asks first: its steps go with it. */
  const handleRemoveLane = (nodeId: string, laneIndex: number) => {
    if (!tree) return;
    const place = tree.nodePath.get(nodeId);
    const block = place
      ? seqAt(tree, place.path)?.blocks[place.index]
      : tree.root.blocks[0];
    const lane = block?.kind === "fork" ? block.lanes[laneIndex] : undefined;
    const count = lane
      ? treeNodes({ root: lane.body, detached: [], origin: null }).length
      : 0;
    if (count > 0) setPendingLane({ nodeId, laneIndex, count });
    else doRemoveLane(nodeId, laneIndex);
  };

  const handleWrapInLoop = (nodeId: string) => {
    if (!scenario || !tree) return;
    const place = tree.nodePath.get(nodeId);
    const seq = place ? seqAt(tree, place.path) : null;
    if (!place || !seq) return;
    unlessRefused(
      nodeId,
      editCapabilities(tree, { kind: "node", nodeId }).wrapInLoop,
      () =>
        setEdited(
          wrapInLoop(
            scenario,
            tree,
            place.path,
            place.index,
            seq.blocks.length - 1,
          ),
        ),
    );
  };

  /** "Stop repeating": the innermost loop around `nodeId` goes; its steps
   *  run once and go on where the loop went on. */
  /** Both views: the bounds of the loop whose first step is `headerId`. */
  const loopBoundsEditing = useMemo<LoopBoundsEditing | undefined>(
    () =>
      scenario && tree
        ? {
            canSet: (headerId, bounds) =>
              canSetLoopBounds(tree, headerId, bounds),
            onSet: (headerId, bounds) =>
              unlessRefused(
                headerId,
                canSetLoopBounds(tree, headerId, bounds),
                () =>
                  setEdited(setLoopBounds(scenario, tree, headerId, bounds)),
              ),
            stateKeys: collectStateKeys(scenario.nodes),
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenario, tree],
  );

  const handleUnwrapLoop = (nodeId: string) => {
    if (!scenario || !tree) return;
    unlessRefused(
      nodeId,
      editCapabilities(tree, { kind: "node", nodeId }).unwrapLoop,
      () => setEdited(unwrapLoop(scenario, tree, nodeId)),
    );
  };

  const handleStepDataChange = (nodeId: string, data: ScenarioNodeData) => {
    if (!scenario) return;
    setEdited(updateStepData(scenario, nodeId, data));
  };

  const handleLink = (nodeId: string, targetId: string | null) => {
    if (!scenario || !tree) return;
    setEdited(setLink(scenario, tree, nodeId, targetId));
  };

  return {
    setEdited,
    handleMetaChange,
    numberOf,
    handleInsertStep,
    rangeHint,
    showRangeOf,
    handleWrapInLoopRange,
    handleSetLaneExit,
    handleInsertStepIntoLoop,
    handleMoveStepTo,
    handleMove,
    handleDelete,
    handleDeleteRequest,
    handleAddLane,
    doRemoveLane,
    handleRemoveLane,
    handleWrapInLoop,
    loopBoundsEditing,
    handleUnwrapLoop,
    handleStepDataChange,
    handleLink,
  };
}
