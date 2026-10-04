import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { saveEditorScenario } from "../../../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../../../components/scenario/scenarioSerialize";
import ScenarioEvSettingsFields from "../../../../components/scenario/ScenarioEvSettingsFields";
import { compactScenarioEvSettings } from "../../../../components/scenario/compactScenarioEvSettings";
import type {
  ScenarioDefinition,
  ScenarioNodeData,
  ScenarioNodeType,
} from "../../../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../../../data/providers/DataProvider";
import EmptyState from "../../../components/EmptyState";
import SegmentedControl from "../../../components/SegmentedControl";
import {
  addParallelBranch,
  findStepLane,
  insertLaneStep,
  moveLaneStep,
  removeLaneStep,
  updateStepData,
  type StepLane,
} from "../../../lib/scenarioSteps";
import {
  deriveStepLayout,
  layoutSteps,
  stepIndexOf,
} from "../../../lib/stepLayout";
import StepsView from "../run/StepsView";
import { nodeTitle } from "../run/stepVisuals";
import ScenarioMetaBar from "./ScenarioMetaBar";
import StepInspector from "./StepInspector";

// The ReactFlow graph editor is heavy; load it only when the Graph view
// opens.
const ScenarioEditor = lazy(
  () => import("../../../../components/scenario/ScenarioEditor"),
);

type EditorView = "steps" | "graph";

const noop = () => {};

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

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

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
}

/**
 * Scenario editor with two views of the same definition:
 * - **Steps**: the step boxes of `StepsView` (a chain, then at most one fork
 *   of branches) with "+ Add step" under the chain and each branch and
 *   "+ Add parallel branch"; a click selects a step for the inspector on the
 *   right, whose header moves it within its lane or deletes it;
 * - **Graph**: the ReactFlow graph editor (`ScenarioEditor`, embedded), for
 *   any scenario — the only view for a shape `deriveStepLayout` cannot draw
 *   (a join, a loop, a second fork).
 * The content owns the definition, the dirty state and Save in both views;
 * the view is kept in the URL (`view=steps|graph`). Used by the
 * per-connector editor page and, inline, by the Library tab.
 */
const ScenarioEditorContent: React.FC<ScenarioEditorContentProps> = ({
  cpId,
  connectorId,
  scenarioId,
  onBack,
  backLabel,
  library,
}) => {
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

  // A shape the Steps view cannot draw is only shown as a graph. Pinned in
  // the URL (below) rather than derived on each render, so an edit that makes
  // it drawable again does not eject the user from the graph mid-edit.
  const forcedGraph = layout !== null && !layout.supported;
  const view: EditorView = forcedGraph ? "graph" : requestedView;

  const dirty = useMemo(() => {
    if (!scenario || !original) return false;
    return serializedSnapshot(scenario) !== serializedSnapshot(original);
  }, [scenario, original]);

  const selectedNode = useMemo(
    () =>
      (layout && layoutSteps(layout).find((s) => s.id === selectedStepId)) ??
      null,
    [layout, selectedStepId],
  );
  const selectedPlace =
    layout && selectedNode ? findStepLane(layout, selectedNode.id) : null;
  const selectedNumber =
    layout && selectedNode ? stepIndexOf(layout, selectedNode.id) : null;

  const handleMetaChange = (patch: Partial<ScenarioDefinition>) => {
    setScenario((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const handleAddStep = (lane: StepLane, type: ScenarioNodeType) => {
    if (!scenario || !layout) return;
    const steps =
      lane === "main" ? layout.main : layout.fork?.branches[lane]?.steps;
    if (!steps) return;
    const next = insertLaneStep(scenario, layout, lane, steps.length, type);
    const before = new Set(scenario.nodes.map((n) => n.id));
    setScenario(next);
    setSelectedStepId(next.nodes.find((n) => !before.has(n.id))?.id ?? null);
  };

  const handleAddBranch = () => {
    if (!scenario || !layout) return;
    const next = addParallelBranch(scenario, layout);
    const before = new Set(scenario.nodes.map((n) => n.id));
    setScenario(next);
    setSelectedStepId(next.nodes.find((n) => !before.has(n.id))?.id ?? null);
  };

  const handleMove = (nodeId: string, delta: -1 | 1) => {
    if (!scenario || !layout) return;
    setScenario(moveLaneStep(scenario, layout, nodeId, delta));
  };

  const handleDelete = (nodeId: string) => {
    if (!scenario || !layout) return;
    setScenario(removeLaneStep(scenario, layout, nodeId));
    setSelectedStepId((sel) => (sel === nodeId ? null : sel));
  };

  const handleStepDataChange = (nodeId: string, data: ScenarioNodeData) => {
    if (!scenario) return;
    setScenario(updateStepData(scenario, nodeId, data));
  };

  const handleGraphChange = useCallback(
    (graph: Pick<ScenarioDefinition, "nodes" | "edges">) => {
      setScenario((prev) => (prev ? { ...prev, ...graph } : prev));
    },
    [],
  );

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

  useEffect(() => {
    if (forcedGraph && requestedView !== "graph") setView("graph");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setView only wraps the stable setSearchParams
  }, [forcedGraph, requestedView]);

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
        `A run of this scenario is active on ${plural(
          runningUsers,
          "connector",
          "connectors",
        )} and will be stopped. Save?`,
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
      setSaveError("Failed to save scenario. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const backControl = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="mb-4 inline-block text-sm text-cx-accent hover:underline"
    >
      ← {backLabel ?? "Back"}
    </button>
  ) : (
    <Link
      to={"/scenarios"}
      className="mb-4 inline-block text-sm text-cx-accent hover:underline"
    >
      ← Back to scenarios
    </Link>
  );

  if (isLoading) {
    return <div className="text-sm text-cx-muted">Loading…</div>;
  }

  if (notFound || !scenario || !layout) {
    return (
      <div>
        {backControl}
        <EmptyState
          title="Scenario not found"
          hint={
            library
              ? `No library scenario "${scenarioId}".`
              : `No scenario "${scenarioId}" for ${cpId}${
                  connectorId != null ? ` · connector ${connectorId}` : ""
                }.`
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
        showTarget={!library}
        saveLabel={
          library && users.length > 0
            ? `Save and apply to ${plural(users.length, "connector", "connectors")}`
            : "Save"
        }
      />

      {library && (
        <div
          data-testid="library-used-by"
          className="mb-4 flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-cx-muted">
            Used by
          </span>
          {users.length === 0 ? (
            <span className="text-sm text-cx-muted">no connector uses it</span>
          ) : (
            users.map((user) => (
              <Link
                key={`${user.cpId}:${user.connectorId ?? "cp"}`}
                to={
                  user.connectorId === null
                    ? `/cp/${encodeURIComponent(user.cpId)}`
                    : `/cp/${encodeURIComponent(user.cpId)}?connector=${user.connectorId}`
                }
                title={user.running ? "running" : undefined}
                className="inline-flex items-center gap-1.5 rounded-md border border-cx-border bg-cx-card px-2 py-0.5 font-mono text-xs text-cx-fg2 hover:border-cx-border-strong hover:text-cx-fg"
              >
                {user.running && (
                  <span
                    aria-label="running"
                    className="h-[7px] w-[7px] rounded-full bg-cx-blue"
                  />
                )}
                {user.cpId}
                {user.connectorId === null
                  ? " · charge point"
                  : ` #${user.connectorId}`}
              </Link>
            ))
          )}
        </div>
      )}

      {/* The rest of the scenario's settings, which the classic graph
          editor's settings dialog also edits (#424). */}
      <div className="mb-4 space-y-2">
        <input
          aria-label="Scenario description"
          placeholder="Description (optional)"
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

      <SegmentedControl
        label="Editor view"
        className="mb-4"
        value={view}
        onChange={setView}
        options={[
          {
            value: "steps",
            label: "Steps",
            disabled: !layout.supported,
            title: layout.supported
              ? undefined
              : "This scenario has a join, a loop or a second fork: the Steps view cannot show it",
          },
          { value: "graph", label: "Graph" },
        ]}
      />

      {view === "graph" ? (
        <div className="h-[70vh] min-h-[480px] overflow-hidden rounded-xl border border-cx-border">
          <Suspense
            fallback={
              <div className="p-4 text-sm text-cx-muted">
                Loading graph editor…
              </div>
            }
          >
            <ScenarioEditor
              key={scenario.id}
              cpId={cpId}
              connectorId={connectorId}
              scenario={scenario}
              onClose={noop}
              embedded={{ onGraphChange: handleGraphChange }}
            />
          </Suspense>
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <StepsView
              layout={layout}
              editable
              selectedStepId={selectedStepId}
              onSelectStep={setSelectedStepId}
              onAddStep={handleAddStep}
              onAddBranch={handleAddBranch}
            />
          </div>
          <div className="min-w-0 rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] lg:sticky lg:top-4 lg:w-[400px] lg:shrink-0 dark:shadow-none">
            {selectedNode && selectedPlace && selectedNumber !== null ? (
              <>
                <div className="mb-3 flex items-center gap-2 border-b border-cx-border pb-3">
                  <span
                    className="min-w-0 flex-1 text-xs text-cx-muted"
                    title={nodeTitle(selectedNode)}
                  >
                    Step <span className="font-mono">{selectedNumber}</span>
                    {selectedPlace.lane !== "main" &&
                      ` · ${layout.fork?.branches[selectedPlace.lane]?.name ?? ""}`}
                  </span>
                  <InspectorAction
                    label={`Move step ${selectedNumber} up`}
                    disabled={selectedPlace.index === 0}
                    onClick={() => handleMove(selectedNode.id, -1)}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </InspectorAction>
                  <InspectorAction
                    label={`Move step ${selectedNumber} down`}
                    disabled={selectedPlace.index === selectedPlace.length - 1}
                    onClick={() => handleMove(selectedNode.id, 1)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </InspectorAction>
                  <InspectorAction
                    label={`Delete step ${selectedNumber}`}
                    danger
                    onClick={() => handleDelete(selectedNode.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </InspectorAction>
                </div>
                <StepInspector
                  node={selectedNode}
                  onChange={(data) =>
                    handleStepDataChange(selectedNode.id, data)
                  }
                />
              </>
            ) : (
              <EmptyState
                title="Select a step"
                hint="Pick a step on the left to edit its configuration."
              />
            )}
          </div>
        </div>
      )}
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
