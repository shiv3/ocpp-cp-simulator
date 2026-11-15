import { useTranslation } from "react-i18next";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import CollapsibleSide from "../../../components/CollapsibleSide";
import { sidePanelGrid, useCollapsedPanel } from "../../../lib/collapsedPanel";

import { Link, useSearchParams } from "react-router-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { t as tNow } from "../../../../i18n";
import { saveEditorScenario } from "../../../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../../../components/scenario/scenarioSerialize";
import ScenarioEvSettingsFields from "../../../../components/scenario/ScenarioEvSettingsFields";
import { compactScenarioEvSettings } from "../../../../components/scenario/compactScenarioEvSettings";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../../../data/providers/DataProvider";
import EmptyState from "../../../components/EmptyState";
import InlineConfirm from "../../../components/InlineConfirm";
import SegmentedControl from "../../../components/SegmentedControl";
import {
  editCapabilities,
  recognizeBlockTree,
  seqAt,
} from "../../../lib/blockTree";
import { isDrawableTree, stepNumbers, treeSteps } from "../../../lib/stepTree";
import { graphEdgeIds } from "../../../lib/treeGraphLayout";
import StepsGraphView from "../run/StepsGraphView";
import StepsView from "../run/StepsView";
import { laneLetter, nodeTitle } from "../run/stepVisuals";
import ScenarioMetaBar from "./ScenarioMetaBar";
import GraphIssues from "./GraphIssues";
import { useScenarioIssues, type ViewIssues } from "./issueMarkUi";
import UnsupportedOutline from "./UnsupportedOutline";
import type { EditorView, LibraryEditorBinding } from "./editorTypes";
import { InspectorPanelBody } from "./InspectorPanelBody";
import { LibraryUsedBy } from "./LibraryUsedBy";
import { PanelActions } from "./PanelActions";
import { useScenarioEditing } from "./useScenarioEditing";

const INSPECTOR_COLLAPSED_KEY = "ocpp-cp.console.scenario.inspector.collapsed";

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

export type { LibraryEditorUser, LibraryEditorBinding } from "./editorTypes";

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
  /** The search parameter holding the editor's Graph / Steps view. */
  viewParam?: string;
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
  viewParam = "view",
}) => {
  const { t } = useTranslation();
  const isPanel = variant === "panel";
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, chargePointService, defaultEvSettings } = useDataContext();
  const requestedView: EditorView =
    searchParams.get(viewParam) === "steps" ? "steps" : "graph";

  const [original, setOriginal] = useState<ScenarioDefinition | null>(null);
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedStepId, setSelectedStep] = useState<string | null>(null);
  /** A lane tag was clicked: its switch / choice is selected and the
   *  inspector opens that lane's row. */
  const [laneFocus, setLaneFocus] = useState<{
    nodeId: string;
    handle: string;
    nonce: number;
  } | null>(null);
  const setSelectedStepId = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      setLaneFocus(null);
      setSelectedStep(next);
    },
    [],
  );
  const openLane = (nodeId: string, handle: string) => {
    setSelectedStep(nodeId);
    setLaneFocus((prev) => ({ nodeId, handle, nonce: (prev?.nonce ?? 0) + 1 }));
  };
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
  }, [chargePointService, cpId, connectorId, scenarioId, setSelectedStepId]);

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

  const {
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
  } = useScenarioEditing({
    scenario,
    tree,
    numbers,
    setScenario,
    setSelectedStepId,
    setNotice,
    setPendingDelete,
    setPendingLane,
  });

  const setView = (view: EditorView) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(viewParam, view);
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
    <PanelActions
      onCancel={onCancel}
      expand={expand}
      onClose={onClose}
      handleCancel={handleCancel}
      handleClose={handleClose}
    />
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

      {library && <LibraryUsedBy users={users} />}

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
                  onSelectLane={openLane}
                  onInsertStep={handleInsertStep}
                  onWrapInLoopRange={handleWrapInLoopRange}
                  onSetLaneExit={handleSetLaneExit}
                  highlightIds={rangeHint ?? undefined}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddLane={handleAddLane}
                  onRemoveLane={handleRemoveLane}
                  onUnwrapLoop={handleUnwrapLoop}
                  loopBounds={loopBoundsEditing}
                  issues={viewIssues}
                />
              ) : (
                <StepsView
                  tree={tree}
                  editable
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  onSelectLane={openLane}
                  onInsertStep={handleInsertStep}
                  onInsertStepIntoLoop={handleInsertStepIntoLoop}
                  onMoveStepTo={handleMoveStepTo}
                  highlightIds={rangeHint ?? undefined}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddLane={handleAddLane}
                  onRemoveLane={handleRemoveLane}
                  onUnwrapLoop={handleUnwrapLoop}
                  loopBounds={loopBoundsEditing}
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
              <InspectorPanelBody
                selectedNode={selectedNode}
                selectedNumber={selectedNumber}
                caps={caps}
                showLink={showLink}
                selectedExit={selectedExit}
                allSteps={allSteps}
                reachesSelected={reachesSelected}
                numbers={numbers}
                numberOf={numberOf}
                laneFocus={laneFocus}
                scenario={scenario}
                onScenarioChange={setScenario}
                handleAddLane={handleAddLane}
                handleWrapInLoop={handleWrapInLoop}
                handleUnwrapLoop={handleUnwrapLoop}
                handleMove={handleMove}
                handleDelete={handleDelete}
                handleLink={handleLink}
                handleStepDataChange={handleStepDataChange}
                showRangeOf={showRangeOf}
              />
            </CollapsibleSide>
          </div>
        </div>
      }
    </div>
  );
};

export default ScenarioEditorContent;
