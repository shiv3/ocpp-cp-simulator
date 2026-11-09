import { useTranslation } from "react-i18next";
import React, { useEffect, useMemo, useRef, useState } from "react";

import CollapsibleSide from "../../../components/CollapsibleSide";
import { sidePanelGrid, useCollapsedPanel } from "../../../lib/collapsedPanel";

import { Link, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  Maximize2,
  Repeat,
  RepeatOff,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t as tNow } from "../../../../i18n";
import { saveEditorScenario } from "../../../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../../../components/scenario/scenarioSerialize";
import ScenarioEvSettingsFields from "../../../../components/scenario/ScenarioEvSettingsFields";
import { compactScenarioEvSettings } from "../../../../components/scenario/compactScenarioEvSettings";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../../../data/providers/DataProvider";
import EmptyState from "../../../components/EmptyState";
import InlineConfirm from "../../../components/InlineConfirm";
import SegmentedControl from "../../../components/SegmentedControl";
import { updateStepData } from "../../../lib/scenarioSteps";
import {
  addLane,
  canMoveStep,
  editCapabilities,
  insertForkBlock,
  insertStep,
  moveStep,
  recognizeBlockTree,
  removeLane,
  removeStep,
  seqAt,
  setLink,
  treeNodes,
  unwrapLoop,
  wrapInLoop,
  type Capability,
  type SeqPath,
} from "../../../lib/blockTree";
import { isDrawableTree, stepNumbers, treeSteps } from "../../../lib/stepTree";
import { graphEdgeIds } from "../../../lib/treeGraphLayout";
import StepsGraphView from "../run/StepsGraphView";
import StepsView from "../run/StepsView";
import { laneLetter, nodeTitle } from "../run/stepVisuals";
import ScenarioMetaBar from "./ScenarioMetaBar";
import GraphIssues from "./GraphIssues";
import { useScenarioIssues, type ViewIssues } from "./issueMarkUi";
import StepInspector from "./StepInspector";
import UnsupportedOutline from "./UnsupportedOutline";

const INSPECTOR_COLLAPSED_KEY = "ocpp-cp.console.scenario.inspector.collapsed";

type EditorView = "steps" | "graph";

/** JSON snapshot used for dirty-tracking: deep-compares the *serialized*
 *  def (runtime-only node/edge fields stripped, same as what
 *  `saveEditorScenario` persists) rather than the raw editor state, so
 *  fields ReactFlow/the executor tack on transiently never cause a false
 *  "unsaved changes" indicator. */
function serializedSnapshot(def: ScenarioDefinition): string {
  return JSON.stringify({
    ...def,
    ...serializeScenarioGraph(def.nodes, def.edges),
  });
}

const connectorCount = (n: number) =>
  tNow("scenarios.count.connector", { count: n });

/** A connector that uses the Library scenario being edited. */
export interface LibraryEditorUser {
  cpId: string;
  connectorId: number | null;
  /** A run of the scenario is live there (a save stops it). */
  running: boolean;
}

/** What the Library editor adds to the plain editor: who uses the scenario,
 *  and a save that re-pushes it to them. */
export interface LibraryEditorBinding {
  users: LibraryEditorUser[];
  save: (scenario: ScenarioDefinition) => Promise<void>;
}

export interface ScenarioEditorContentProps {
  /** The definition's scope (`LIBRARY_SCOPE` and null for a Library entry). */
  cpId: string;
  connectorId: number | null;
  scenarioId: string;
  /** A back button calling this (with `backLabel`) instead of the link to
   *  `/scenarios`. */
  onBack?: () => void;
  backLabel?: string;
  /** Set for a Library scenario: Used by, and Save applies to the users. */
  library?: LibraryEditorBinding;
  /** `panel`: the side panel's layout — the header holds the name, trigger,
   *  Enabled, Save, Cancel, the expand link and close; the inspector goes
   *  under the steps. `page` (default): the editor page. */
  variant?: "page" | "panel";
  /** panel: back to the read view (asked first when there are unsaved
   *  changes). */
  onCancel?: () => void;
  /** panel: the expand button, to the editor page on the same scenario. */
  expand?: { to: string; label: string };
  /** panel: the close button. */
  onClose?: () => void;
  /** panel: filled with this editor's Cancel (asks first when there are
   *  unsaved changes), for the host to route the side panel's Esc to. */
  cancelRef?: React.RefObject<(() => void) | null>;
}

/**
 * Scenario editor with two views of the same definition, both drawing its
 * block tree (`recognizeBlockTree`):
 * - **Steps**: the step boxes of `StepsView`, nested;
 * - **Graph**: the same tree as connected cards (`StepsGraphView`, as on
 *   the run page).
 * Both take the same edits, all through the tree's operations and enabled
 * from `editCapabilities`: insert at a slot (a switch / choice with its
 * lanes), drag or Alt+Arrow within a sequence, delete, add / remove a
 * branch; the inspector adds wrap-in-loop and the After-step jump. A
 * scenario without a START is listed as an outline.
 * The content owns the definition, the dirty state and Save in both views;
 * the view is kept in the URL (`view=steps|graph`); Graph is the default. Used by the
 * per-connector editor page, inline by the Library tab, and in the
 * Scenarios page's and the charge point page's side panels (`variant`).
 */
const ScenarioEditorContent: React.FC<ScenarioEditorContentProps> = ({
  cpId,
  connectorId,
  scenarioId,
  onBack,
  backLabel,
  library,
  variant = "page",
  onCancel,
  expand,
  onClose,
  cancelRef,
}) => {
  const { t } = useTranslation();
  const isPanel = variant === "panel";
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, chargePointService, defaultEvSettings } = useDataContext();
  const requestedView: EditorView =
    searchParams.get("view") === "steps" ? "steps" : "graph";

  const [original, setOriginal] = useState<ScenarioDefinition | null>(null);
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A step the keyboard asked to delete, waiting for the in-page answer. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** A lane (with steps) asked to be removed, waiting for the answer. */
  const [pendingLane, setPendingLane] = useState<{
    nodeId: string;
    laneIndex: number;
    count: number;
  } | null>(null);
  /** Why the last structural edit asked for was refused. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Leaving with unsaved changes waits for the in-page answer: back to the
   *  read view (Cancel, Esc) or out of the panel (close). */
  const [confirmLeave, setConfirmLeave] = useState<"cancel" | "close" | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);
    setSelectedStepId(null);

    chargePointService
      .listScenarioDefinitions(cpId, connectorId)
      .then((defs) => {
        if (cancelled) return;
        const found = (defs ?? []).find((d) => d.id === scenarioId) ?? null;
        setOriginal(found);
        setScenario(found);
        setNotFound(!found);
      })
      .catch((err) => {
        console.error("Failed to load scenario definitions", err);
        if (!cancelled) {
          setOriginal(null);
          setScenario(null);
          setNotFound(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chargePointService, cpId, connectorId, scenarioId]);

  // The editing model: every structural edit goes through the tree.
  const tree = useMemo(
    () => (scenario ? recognizeBlockTree(scenario) : null),
    [scenario],
  );
  const numbers = useMemo(
    () => (tree ? stepNumbers(tree) : new Map<string, number>()),
    [tree],
  );

  // Without a START neither view draws the scenario: it is listed as an
  // outline, its steps editable, their wiring not.
  const drawable = tree === null || isDrawableTree(tree);
  const view: EditorView = requestedView;
  const graphShown = view === "graph";
  const graphEdges = useMemo(
    () => (graphShown && tree ? graphEdgeIds(tree) : null),
    [graphShown, tree],
  );

  // The wiring's diagnostics, once per change, marked in the view shown.
  const {
    issues,
    describe: describeIssue,
    marks,
  } = useScenarioIssues(
    scenario,
    tree,
    !drawable ? "outline" : graphShown ? "graph" : "steps",
    graphEdges,
  );
  /** A warning line pointed at (hover / focus), and a marked step pointed at. */
  const panel = useCollapsedPanel(INSPECTOR_COLLAPSED_KEY);
  // Picking a step opens the panel it is edited in.
  useEffect(() => {
    if (selectedStepId !== null) panel.setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStepId]);
  const [hoveredIssue, setHoveredIssue] = useState<number | null>(null);
  const [hoveredStep, setHoveredStep] = useState<string | null>(null);
  const viewIssues: ViewIssues = {
    marks,
    highlight: hoveredIssue,
    onHoverStep: setHoveredStep,
  };
  const stepsRef = useRef<HTMLDivElement>(null);
  /** A warning line's step: select it (the inspector opens) and bring it
   *  into view. */
  const showIssueStep = (stepId: string) => {
    setSelectedStepId(stepId);
    const el = stepsRef.current?.querySelector(
      `[data-node-id="${CSS.escape(stepId)}"], [data-step-id="${CSS.escape(stepId)}"]`,
    );
    el?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  };

  const dirty = useMemo(() => {
    if (!scenario || !original) return false;
    return serializedSnapshot(scenario) !== serializedSnapshot(original);
  }, [scenario, original]);

  const selectedNode = useMemo(
    () =>
      (scenario &&
        scenario.nodes.find(
          (n) =>
            n.id === selectedStepId &&
            n.type !== ScenarioNodeType.START &&
            n.type !== ScenarioNodeType.END,
        )) ??
      null,
    [scenario, selectedStepId],
  );
  const allSteps = useMemo(() => (tree ? treeSteps(tree) : []), [tree]);
  const pendingNode = allSteps.find((s) => s.id === pendingDelete) ?? null;
  const selectedNumber = selectedNode
    ? (numbers.get(selectedNode.id) ?? null)
    : null;
  const caps =
    tree && selectedNode && drawable && tree.nodePath.has(selectedNode.id)
      ? editCapabilities(tree, { kind: "node", nodeId: selectedNode.id })
      : null;
  /** Where the selected step's sequence goes after it (its last step):
   *  the step it jumps or falls through to, "" for END or nothing. */
  const selectedExit = (() => {
    if (!tree || !selectedNode) return "";
    const place = tree.nodePath.get(selectedNode.id);
    const exit = place ? seqAt(tree, place.path)?.exit : undefined;
    if (exit?.kind === "link") return exit.target;
    if (exit?.kind === "fallthrough") return exit.to;
    return "";
  })();
  /** The steps a run can go from to the selected one: a jump there goes
   *  back ("Loop back to step n"); any other target is "Go to step n". */
  const reachesSelected = useMemo(() => {
    const out = new Set<string>();
    if (!scenario || !selectedNode) return out;
    const into = new Map<string, string[]>();
    for (const e of scenario.edges) {
      const list = into.get(e.target);
      if (list) list.push(e.source);
      else into.set(e.target, [e.source]);
    }
    const work = [selectedNode.id];
    while (work.length > 0) {
      const id = work.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      work.push(...(into.get(id) ?? []));
    }
    return out;
  }, [scenario, selectedNode]);
  // The jump select: on the last step of a sequence; a refusal other than
  // "not the last step" is shown with its reason.
  const showLink =
    caps !== null &&
    (caps.setLink.ok ||
      caps.setLink.reason === "scenarios.editor.cannot.insideLoop");

  const handleMetaChange = (patch: Partial<ScenarioDefinition>) => {
    setScenario((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  /** Selects the step a change added (the one id `next` has that the
   *  scenario had not). */
  const applyAndSelectNew = (next: ScenarioDefinition) => {
    if (!scenario) return;
    const before = new Set(scenario.nodes.map((n) => n.id));
    setScenario(next);
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
    type: ScenarioNodeType,
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
        setScenario(
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
      setScenario(removeStep(scenario, tree, nodeId));
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
      () => setScenario(removeLane(scenario, tree, nodeId, laneIndex)),
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
        setScenario(
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
  const handleUnwrapLoop = (nodeId: string) => {
    if (!scenario || !tree) return;
    unlessRefused(
      nodeId,
      editCapabilities(tree, { kind: "node", nodeId }).unwrapLoop,
      () => setScenario(unwrapLoop(scenario, tree, nodeId)),
    );
  };

  const handleStepDataChange = (nodeId: string, data: ScenarioNodeData) => {
    if (!scenario) return;
    setScenario(updateStepData(scenario, nodeId, data));
  };

  const handleLink = (nodeId: string, targetId: string | null) => {
    if (!scenario || !tree) return;
    setScenario(setLink(scenario, tree, nodeId, targetId));
  };

  const setView = (view: EditorView) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("view", view);
        return next;
      },
      { replace: true },
    );
  };

  const users = library?.users ?? [];
  const runningUsers = users.filter((user) => user.running).length;

  const handleSave = async () => {
    if (!scenario) return;
    // Re-pushing replaces each user's definition set, which discards a run
    // in flight there (the daemon's runtime reload): say so first.
    if (
      runningUsers > 0 &&
      typeof window !== "undefined" &&
      !window.confirm(
        t("scenarios.page.confirmStopRuns", {
          connectors: connectorCount(runningUsers),
        }),
      )
    ) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      if (library) {
        await library.save(scenario);
      } else {
        await saveEditorScenario(
          { mode, chargePointService, cpId, connectorId },
          scenario,
        );
      }
      setOriginal(scenario);
    } catch (err) {
      console.error("Failed to save scenario", err);
      setSaveError(t("scenarios.editor.saveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (dirty) setConfirmLeave("cancel");
    else onCancel?.();
  };

  const handleClose = () => {
    if (dirty) setConfirmLeave("close");
    else onClose?.();
  };
  // The host's Esc is Cancel too: hand it the latest handler.
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;
  useEffect(() => {
    if (!cancelRef) return undefined;
    const request = () => handleCancelRef.current();
    cancelRef.current = request;
    return () => {
      if (cancelRef.current === request) cancelRef.current = null;
    };
  }, [cancelRef]);

  const panelActions = isPanel ? (
    <>
      {onCancel && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCancel}
        >
          {t("scenarios.common.cancel")}
        </Button>
      )}
      {expand && (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="px-2"
          title={expand.label}
        >
          <Link to={expand.to} aria-label={expand.label}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
      {onClose && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-2"
          aria-label={t("scenarios.panel.closeAria")}
          title={t("scenarios.panel.closeTitle")}
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </>
  ) : null;

  const backControl = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="mb-4 inline-block text-sm text-cx-accent hover:underline"
    >
      ← {backLabel ?? t("scenarios.meta.back")}
    </button>
  ) : (
    <Link
      to={"/scenarios"}
      className="mb-4 inline-block text-sm text-cx-accent hover:underline"
    >
      ← {t("scenarios.editor.backToScenarios")}
    </Link>
  );

  if (isLoading) {
    return (
      <div className="text-sm text-cx-muted">
        {t("scenarios.editor.loading")}
      </div>
    );
  }

  if (notFound || !scenario || !tree) {
    return (
      <div>
        {isPanel ? (
          <div className="mb-2 flex justify-end gap-2">{panelActions}</div>
        ) : (
          backControl
        )}
        <EmptyState
          title={t("scenarios.panel.notFound")}
          hint={
            library
              ? t("scenarios.editor.libraryNotFound", { scenarioId })
              : t("scenarios.editor.notFoundHint", {
                  scenarioId,
                  cpId,
                  connector:
                    connectorId != null
                      ? t("scenarios.editor.connectorSuffix", { connectorId })
                      : "",
                })
          }
        />
      </div>
    );
  }

  return (
    <div>
      <ScenarioMetaBar
        scenario={scenario}
        cpId={cpId}
        connectorId={connectorId}
        dirty={dirty}
        isSaving={isSaving}
        onChange={handleMetaChange}
        onSave={() => void handleSave()}
        onBack={onBack}
        backLabel={backLabel}
        showTarget={!library && !isPanel}
        variant={variant}
        actions={panelActions}
        saveLabel={
          library && users.length > 0
            ? t("scenarios.editor.saveAndApply", {
                connectors: connectorCount(users.length),
              })
            : t("scenarios.meta.save")
        }
      />

      {confirmLeave && (
        <InlineConfirm
          className="mb-4"
          message={t("scenarios.editor.discardMessage")}
          cancelLabel={t("scenarios.editor.keepEditing")}
          confirmLabel={t("scenarios.editor.discard")}
          danger
          onCancel={() => setConfirmLeave(null)}
          onConfirm={() => {
            const leave = confirmLeave;
            setConfirmLeave(null);
            if (leave === "close") onClose?.();
            else onCancel?.();
          }}
        />
      )}

      {library && (
        <div
          data-testid="library-used-by"
          className="mb-4 flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-cx-muted">
            {t("scenarios.editor.usedBy")}
          </span>
          {users.length === 0 ? (
            <span className="text-sm text-cx-muted">
              {t("scenarios.editor.noConnectorUses")}
            </span>
          ) : (
            users.map((user) => (
              <Link
                key={`${user.cpId}:${user.connectorId ?? "cp"}`}
                to={
                  user.connectorId === null
                    ? `/cp/${encodeURIComponent(user.cpId)}`
                    : `/cp/${encodeURIComponent(user.cpId)}?connector=${user.connectorId}`
                }
                title={user.running ? t("scenarios.editor.running") : undefined}
                className="inline-flex items-center gap-1.5 rounded-md border border-cx-border bg-cx-card px-2 py-0.5 font-mono text-xs text-cx-fg2 hover:border-cx-border-strong hover:text-cx-fg"
              >
                {user.running && (
                  <span
                    aria-label={t("scenarios.editor.running")}
                    className="h-[7px] w-[7px] rounded-full bg-cx-blue"
                  />
                )}
                {user.cpId}
                {user.connectorId === null
                  ? ` · ${t("scenarios.editor.chargePoint")}`
                  : ` #${user.connectorId}`}
              </Link>
            ))
          )}
        </div>
      )}

      {/* The rest of the scenario's settings: description and EV
          settings (#424). */}
      <div className="mb-4 space-y-2">
        <input
          aria-label={t("scenarios.editor.descriptionAria")}
          placeholder={t("scenarios.editor.descriptionPlaceholder")}
          value={scenario.description ?? ""}
          // An erased description is no description, not "".
          onChange={(e) =>
            handleMetaChange({ description: e.target.value || undefined })
          }
          className="w-full rounded-md border border-cx-border-strong bg-cx-card px-3 py-1.5 text-sm text-cx-fg"
        />
        <ScenarioEvSettingsFields
          className="bg-cx-card"
          value={scenario.evSettings ?? {}}
          onChange={(next) =>
            handleMetaChange({ evSettings: compactScenarioEvSettings(next) })
          }
          defaultEvSettings={defaultEvSettings}
          initiallyExpanded={false}
        />
      </div>

      {saveError && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-sm text-cx-rose"
        >
          {saveError}
        </div>
      )}

      {drawable && (
        <SegmentedControl
          label={t("scenarios.editor.editorView")}
          className="mb-4"
          value={view}
          onChange={setView}
          options={[
            { value: "graph", label: t("scenarios.editor.viewGraph") },
            { value: "steps", label: t("scenarios.editor.viewSteps") },
          ]}
        />
      )}

      <GraphIssues
        issues={issues}
        describe={describeIssue}
        marks={marks}
        hoveredStepId={hoveredStep}
        onHoverIssue={setHoveredIssue}
        onSelectStep={showIssueStep}
      />

      {notice && (
        <div
          role="status"
          data-testid="edit-refused"
          className="mb-3 flex items-start gap-2 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-fg2"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            aria-label={t("scenarios.editor.dismiss")}
            title={t("scenarios.editor.dismiss")}
            onClick={() => setNotice(null)}
            className="rounded p-0.5 text-cx-faint hover:text-cx-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {pendingLane && (
        <InlineConfirm
          className="mb-3"
          message={t("scenarios.editor.removeLaneConfirm", {
            lane: laneLetter(pendingLane.laneIndex),
            count: pendingLane.count,
          })}
          cancelLabel={t("scenarios.editor.keep")}
          confirmLabel={t("scenarios.editor.remove")}
          danger
          onCancel={() => setPendingLane(null)}
          onConfirm={() =>
            doRemoveLane(pendingLane.nodeId, pendingLane.laneIndex)
          }
        />
      )}

      {pendingDelete && (
        <InlineConfirm
          className="mb-3"
          message={t("scenarios.editor.deleteStepConfirm", {
            n: numberOf(pendingDelete),
            title: pendingNode ? nodeTitle(pendingNode) : "",
          })}
          cancelLabel={t("scenarios.editor.keep")}
          confirmLabel={t("scenarios.editor.delete")}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => handleDelete(pendingDelete)}
        />
      )}

      {
        // A container query, not the window width: the editor sits on a page
        // or in a side panel the user can drag wide, and only its own width
        // says whether the inspector fits beside the steps (the mock's
        // `.editor > .insp`) or goes under them.
        <div data-testid="editor-body" className="@container">
          <div
            data-testid="editor-grid"
            className={cn(
              "grid grid-cols-1 items-start gap-4",
              sidePanelGrid(panel.collapsed, "860"),
            )}
          >
            {/* min-w-0: the graph scrolls sideways inside its own column. */}
            <div ref={stepsRef} className="min-w-0">
              {!drawable ? (
                <UnsupportedOutline
                  scenario={scenario}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  issues={viewIssues}
                />
              ) : !tree ? null : graphShown ? (
                <StepsGraphView
                  tree={tree}
                  editable
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  onInsertStep={handleInsertStep}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddLane={handleAddLane}
                  onRemoveLane={handleRemoveLane}
                  onUnwrapLoop={handleUnwrapLoop}
                  issues={viewIssues}
                />
              ) : (
                <StepsView
                  tree={tree}
                  editable
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  onInsertStep={handleInsertStep}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddLane={handleAddLane}
                  onRemoveLane={handleRemoveLane}
                  onUnwrapLoop={handleUnwrapLoop}
                  issues={viewIssues}
                />
              )}
            </div>
            <CollapsibleSide
              collapsed={panel.collapsed}
              onCollapsedChange={panel.setCollapsed}
              label={t("scenarios.inspector.rail")}
              className="@[860px]:sticky @[860px]:top-4"
              contentClassName="p-4"
            >
              {selectedNode ? (
                <>
                  <div className="mb-3 flex items-center gap-2 border-b border-cx-border pb-3">
                    <span
                      className="min-w-0 flex-1 text-xs text-cx-muted"
                      title={nodeTitle(selectedNode)}
                    >
                      {selectedNumber !== null ? (
                        <>
                          {t("scenarios.editor.step")}{" "}
                          <span className="font-mono">{selectedNumber}</span>
                        </>
                      ) : (
                        nodeTitle(selectedNode)
                      )}
                    </span>
                    {caps && selectedNumber !== null && (
                      <>
                        {(caps.addLane.ok ||
                          caps.addLane.reason !==
                            "scenarios.editor.cannot.cannotFork") && (
                          <InspectorAction
                            label={t("scenarios.editor.addBranch")}
                            cap={caps.addLane}
                            onClick={() => handleAddLane(selectedNode.id)}
                          >
                            <GitBranch className="h-3.5 w-3.5" />
                          </InspectorAction>
                        )}
                        <InspectorAction
                          label={t("scenarios.editor.wrapInLoop")}
                          cap={caps.wrapInLoop}
                          onClick={() => handleWrapInLoop(selectedNode.id)}
                        >
                          <Repeat className="h-3.5 w-3.5" />
                        </InspectorAction>
                        {(caps.unwrapLoop.ok ||
                          caps.unwrapLoop.reason !==
                            "scenarios.editor.cannot.notInLoop") && (
                          <InspectorAction
                            label={t("scenarios.editor.unwrapLoop")}
                            cap={caps.unwrapLoop}
                            onClick={() => handleUnwrapLoop(selectedNode.id)}
                          >
                            <RepeatOff className="h-3.5 w-3.5" />
                          </InspectorAction>
                        )}
                        <InspectorAction
                          label={t("scenarios.editor.moveUp", {
                            n: selectedNumber,
                          })}
                          cap={caps.moveUp}
                          onClick={() => handleMove(selectedNode.id, -1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </InspectorAction>
                        <InspectorAction
                          label={t("scenarios.editor.moveDown", {
                            n: selectedNumber,
                          })}
                          cap={caps.moveDown}
                          onClick={() => handleMove(selectedNode.id, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </InspectorAction>
                        <InspectorAction
                          label={t("scenarios.editor.deleteStep", {
                            n: selectedNumber,
                          })}
                          cap={caps.removeStep}
                          danger
                          onClick={() => handleDelete(selectedNode.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </InspectorAction>
                      </>
                    )}
                  </div>
                  {caps && showLink && (
                    <label className="mb-3 flex flex-col gap-1 text-xs text-cx-muted">
                      {t("scenarios.editor.afterStep")}
                      <select
                        aria-label={t("scenarios.editor.afterStep")}
                        value={selectedExit}
                        disabled={!caps.setLink.ok}
                        title={
                          caps.setLink.ok ? undefined : t(caps.setLink.reason)
                        }
                        onChange={(e) =>
                          handleLink(
                            selectedNode.id,
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        className="rounded-md border border-cx-border-strong bg-cx-card px-2 py-1.5 text-sm text-cx-fg disabled:opacity-60"
                      >
                        <option value="">
                          {t("scenarios.editor.endOfScenario")}
                        </option>
                        {allSteps.map((step) => (
                          <option key={step.id} value={step.id}>
                            {t(
                              reachesSelected.has(step.id)
                                ? "scenarios.editor.loopBackTo"
                                : "scenarios.editor.goToStep",
                              {
                                n: numberOf(step.id),
                                title: nodeTitle(step),
                              },
                            )}
                          </option>
                        ))}
                      </select>
                      {!caps.setLink.ok && (
                        <span>{t(caps.setLink.reason)}</span>
                      )}
                    </label>
                  )}
                  <StepInspector
                    node={selectedNode}
                    onChange={(data) =>
                      handleStepDataChange(selectedNode.id, data)
                    }
                    scenario={scenario}
                    onScenarioChange={setScenario}
                    stepNumbers={numbers}
                  />
                </>
              ) : (
                <EmptyState
                  title={t("scenarios.inspector.selectStep")}
                  hint={t("scenarios.inspector.selectStepHint")}
                />
              )}
            </CollapsibleSide>
          </div>
        </div>
      }
    </div>
  );
};

/** An inspector button, disabled with the reason as title when `cap`
 *  refuses (and its note in the title when it has one). */
const InspectorAction: React.FC<{
  label: string;
  cap: Capability;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, cap, danger, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={
      !cap.ok
        ? `${label}: ${tNow(cap.reason)}`
        : cap.note
          ? `${label} — ${tNow(cap.note)}`
          : label
    }
    disabled={!cap.ok}
    onClick={onClick}
    className={cn(
      "rounded p-1 text-cx-faint disabled:opacity-30",
      danger ? "hover:bg-cx-rose/10 hover:text-cx-rose" : "hover:bg-cx-sub",
    )}
  >
    {children}
  </button>
);

export default ScenarioEditorContent;
