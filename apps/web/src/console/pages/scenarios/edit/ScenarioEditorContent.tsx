import { useTranslation } from "react-i18next";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronUp, Maximize2, Trash2, X } from "lucide-react";

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
import {
  addParallelBranch,
  findStepLane,
  insertLaneStep,
  moveLaneStep,
  laneLinkTarget,
  setLaneLink,
  removeLaneStep,
  updateStepData,
  type StepLane,
} from "../../../lib/scenarioSteps";
import {
  deriveStepLayout,
  layoutSteps,
  stepIndexOf,
} from "../../../lib/stepLayout";
import StepsGraphView from "../run/StepsGraphView";
import StepsView from "../run/StepsView";
import { nodeTitle } from "../run/stepVisuals";
import ScenarioMetaBar from "./ScenarioMetaBar";
import StepInspector from "./StepInspector";
import UnsupportedOutline from "./UnsupportedOutline";

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
 * Scenario editor with two views of the same definition:
 * - **Steps**: the step boxes of `StepsView` (a chain, then at most one fork
 *   of branches) with "+ Add step" under the chain and each branch, a `+`
 *   between two boxes, drag to reorder within a lane and "+ Add parallel
 *   branch"; a click selects a step for the inspector, whose header moves it
 *   within its lane or deletes it;
 * - **Graph**: the same layout as connected cards (`StepsGraphView`, as on
 *   the run page) with `+` discs, "+ branch" and drag. A shape
 *   `deriveStepLayout` cannot draw (a join, a loop, a second fork) opens the
 *   ReactFlow `ScenarioEditor` instead — the only view for it, and kept for
 *   the rest of the visit once opened, so an edit that makes the scenario
 *   drawable does not swap editors mid-edit.
 * The content owns the definition, the dirty state and Save in both views;
 * the view is kept in the URL (`view=steps|graph`). Used by the
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
    searchParams.get("view") === "graph" ? "graph" : "steps";

  const [original, setOriginal] = useState<ScenarioDefinition | null>(null);
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A step the keyboard asked to delete, waiting for the in-page answer. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
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

  const layout = useMemo(
    () => (scenario ? deriveStepLayout(scenario) : null),
    [scenario],
  );

  // A shape neither view can draw (a second fork, a step nothing leads to)
  // is listed as an outline: its steps stay editable, their wiring does not.
  const drawable = layout === null || layout.supported;
  const view: EditorView = requestedView;

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
  const selectedPlace =
    layout && selectedNode ? findStepLane(layout, selectedNode.id) : null;
  const pendingNode =
    (layout && layoutSteps(layout).find((s) => s.id === pendingDelete)) ?? null;
  const selectedNumber =
    layout && selectedNode ? stepIndexOf(layout, selectedNode.id) : null;
  const allSteps = layout ? layoutSteps(layout) : [];
  const closesLane =
    layout !== null &&
    selectedPlace !== null &&
    selectedPlace.index === selectedPlace.length - 1 &&
    !(layout.fork && selectedPlace.lane === "main");

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

  const handleInsertStep = (
    lane: StepLane,
    index: number,
    type: ScenarioNodeType,
  ) => {
    if (!scenario || !layout) return;
    applyAndSelectNew(insertLaneStep(scenario, layout, lane, index, type));
  };

  const handleAddBranch = () => {
    if (!scenario || !layout) return;
    applyAndSelectNew(addParallelBranch(scenario, layout));
  };

  const handleMove = (nodeId: string, delta: number) => {
    if (!scenario || !layout) return;
    setScenario(moveLaneStep(scenario, layout, nodeId, delta));
  };

  const handleDelete = (nodeId: string) => {
    if (!scenario || !layout) return;
    setScenario(removeLaneStep(scenario, layout, nodeId));
    setSelectedStepId((sel) => (sel === nodeId ? null : sel));
    setPendingDelete(null);
  };

  /** The keyboard's Delete asks first (one key away from losing a step);
   *  the ✕ and the inspector's bin are deliberate clicks. */
  const handleDeleteRequest = (
    nodeId: string,
    { confirm }: { confirm: boolean },
  ) => {
    if (confirm) setPendingDelete(nodeId);
    else handleDelete(nodeId);
  };

  const handleStepDataChange = (nodeId: string, data: ScenarioNodeData) => {
    if (!scenario) return;
    setScenario(updateStepData(scenario, nodeId, data));
  };

  const handleLaneLink = (nodeId: string, targetId: string | null) => {
    if (!scenario || !layout) return;
    setScenario(setLaneLink(scenario, layout, nodeId, targetId));
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

  if (notFound || !scenario || !layout) {
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
            { value: "steps", label: t("scenarios.editor.viewSteps") },
            { value: "graph", label: t("scenarios.editor.viewGraph") },
          ]}
        />
      )}

      {pendingDelete && (
        <InlineConfirm
          className="mb-3"
          message={t("scenarios.editor.deleteStepConfirm", {
            n: stepIndexOf(layout, pendingDelete) ?? "",
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
            className="grid grid-cols-1 items-start gap-4 @[860px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]"
          >
            {/* min-w-0: the graph scrolls sideways inside its own column. */}
            <div className="min-w-0">
              {!drawable ? (
                <UnsupportedOutline
                  scenario={scenario}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                />
              ) : view === "graph" ? (
                <StepsGraphView
                  layout={layout}
                  editable
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  onInsertStep={handleInsertStep}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddBranch={handleAddBranch}
                />
              ) : (
                <StepsView
                  layout={layout}
                  editable
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  onInsertStep={handleInsertStep}
                  onMoveStep={handleMove}
                  onDeleteStep={handleDeleteRequest}
                  onAddBranch={handleAddBranch}
                />
              )}
            </div>
            <div
              className={cn(
                "min-w-0 rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none",
                "@[860px]:sticky @[860px]:top-4",
              )}
            >
              {selectedNode ? (
                <>
                  <div className="mb-3 flex items-center gap-2 border-b border-cx-border pb-3">
                    <span
                      className="min-w-0 flex-1 text-xs text-cx-muted"
                      title={nodeTitle(selectedNode)}
                    >
                      {selectedPlace && selectedNumber !== null ? (
                        <>
                          {t("scenarios.editor.step")}{" "}
                          <span className="font-mono">{selectedNumber}</span>
                          {selectedPlace.lane !== "main" &&
                            ` · ${layout?.fork?.branches[selectedPlace.lane]?.name ?? ""}`}
                        </>
                      ) : (
                        nodeTitle(selectedNode)
                      )}
                    </span>
                    {selectedPlace && selectedNumber !== null && (
                      <>
                        <InspectorAction
                          label={t("scenarios.editor.moveUp", {
                            n: selectedNumber,
                          })}
                          disabled={selectedPlace.index === 0}
                          onClick={() => handleMove(selectedNode.id, -1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </InspectorAction>
                        <InspectorAction
                          label={t("scenarios.editor.moveDown", {
                            n: selectedNumber,
                          })}
                          disabled={
                            selectedPlace.index === selectedPlace.length - 1
                          }
                          onClick={() => handleMove(selectedNode.id, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </InspectorAction>
                        <InspectorAction
                          label={t("scenarios.editor.deleteStep", {
                            n: selectedNumber,
                          })}
                          danger
                          onClick={() => handleDelete(selectedNode.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </InspectorAction>
                      </>
                    )}
                  </div>
                  {layout && closesLane && (
                    <label className="mb-3 flex flex-col gap-1 text-xs text-cx-muted">
                      {t("scenarios.editor.afterStep")}
                      <select
                        aria-label={t("scenarios.editor.afterStep")}
                        value={laneLinkTarget(layout, selectedNode.id) ?? ""}
                        onChange={(e) =>
                          handleLaneLink(
                            selectedNode.id,
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        className="rounded-md border border-cx-border-strong bg-cx-card px-2 py-1.5 text-sm text-cx-fg"
                      >
                        <option value="">
                          {t("scenarios.editor.endOfScenario")}
                        </option>
                        {allSteps.map((step) => (
                          <option key={step.id} value={step.id}>
                            {t("scenarios.editor.loopBackTo", {
                              n: stepIndexOf(layout, step.id) ?? "",
                              title: nodeTitle(step),
                            })}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <StepInspector
                    node={selectedNode}
                    onChange={(data) =>
                      handleStepDataChange(selectedNode.id, data)
                    }
                  />
                </>
              ) : (
                <EmptyState
                  title={t("scenarios.inspector.selectStep")}
                  hint={t("scenarios.inspector.selectStepHint")}
                />
              )}
            </div>
          </div>
        </div>
      }
    </div>
  );
};

const InspectorAction: React.FC<{
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, disabled, danger, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
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
