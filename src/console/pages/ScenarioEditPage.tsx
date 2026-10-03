import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";

import { saveEditorScenario } from "../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../components/scenario/scenarioSerialize";
import ScenarioEvSettingsFields from "../../components/scenario/ScenarioEvSettingsFields";
import { compactScenarioEvSettings } from "../../components/scenario/compactScenarioEvSettings";
import type {
  ScenarioDefinition,
  ScenarioNodeData,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../data/providers/DataProvider";
import EmptyState from "../components/EmptyState";
import {
  deriveLinearSteps,
  insertStep,
  moveStep,
  removeStep,
  updateStepData,
} from "../lib/scenarioSteps";
import ScenarioMetaBar from "./scenarios/edit/ScenarioMetaBar";
import StepInspector from "./scenarios/edit/StepInspector";
import StepList from "./scenarios/edit/StepList";

// The ReactFlow graph editor is heavy; load it only when the Graph view
// opens.
const ScenarioEditor = lazy(
  () => import("../../components/scenario/ScenarioEditor"),
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

/**
 * Scenario editor with two views of the same definition:
 * - **Steps**: an ordered step list + schema-driven inspector, for scenarios
 *   that form a single START→…→END chain;
 * - **Graph**: the ReactFlow graph editor (`ScenarioEditor`, embedded), for
 *   any scenario — the only view for branching or looping ones, which the
 *   step list cannot represent (`deriveLinearSteps(...).isLinear`).
 * The page owns the definition, the dirty state and Save in both views; the
 * view is kept in the URL (`view=steps|graph`).
 */
const ScenarioEditPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, chargePointService, defaultEvSettings } = useDataContext();

  const cpId = searchParams.get("cp") ?? "";
  const connectorParam = searchParams.get("connector") ?? "";
  const connectorId = connectorParam === "" ? null : Number(connectorParam);
  const scenarioId = searchParams.get("id") ?? "";
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

  const linear = useMemo(
    () => (scenario ? deriveLinearSteps(scenario) : null),
    [scenario],
  );

  // A branching or looping scenario can only be shown as a graph. Pinned in
  // the URL (below) rather than derived on each render, so an edit that
  // makes the graph linear again does not eject the user from it mid-edit.
  const forcedGraph = linear !== null && !linear.isLinear;
  const view: EditorView = forcedGraph ? "graph" : requestedView;

  const dirty = useMemo(() => {
    if (!scenario || !original) return false;
    return serializedSnapshot(scenario) !== serializedSnapshot(original);
  }, [scenario, original]);

  const selectedNode = useMemo(
    () => linear?.steps.find((s) => s.id === selectedStepId) ?? null,
    [linear, selectedStepId],
  );

  const handleMetaChange = (patch: Partial<ScenarioDefinition>) => {
    setScenario((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const handleInsert = (index: number, type: ScenarioNodeType) => {
    if (!scenario) return;
    const next = insertStep(scenario, index, type);
    const insertedStep = deriveLinearSteps(next).steps[index];
    setScenario(next);
    setSelectedStepId(insertedStep?.id ?? null);
  };

  const handleDelete = (nodeId: string) => {
    if (!scenario) return;
    setScenario(removeStep(scenario, nodeId));
    setSelectedStepId((sel) => (sel === nodeId ? null : sel));
  };

  const handleMove = (fromIndex: number, toIndex: number) => {
    if (!scenario) return;
    setScenario(moveStep(scenario, fromIndex, toIndex));
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

  const handleSave = async () => {
    if (!scenario) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveEditorScenario(
        { mode, chargePointService, cpId, connectorId },
        scenario,
      );
      setOriginal(scenario);
    } catch (err) {
      console.error("Failed to save scenario", err);
      setSaveError("Failed to save scenario. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        Loading…
      </div>
    );
  }

  if (notFound || !scenario || !linear) {
    return (
      <div className="p-6">
        <Link
          to={"/scenarios"}
          className="mb-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Back to scenarios
        </Link>
        <EmptyState
          title="Scenario not found"
          hint={`No scenario "${scenarioId}" for ${cpId}${
            connectorId != null ? ` · connector ${connectorId}` : ""
          }.`}
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <ScenarioMetaBar
        scenario={scenario}
        cpId={cpId}
        connectorId={connectorId}
        dirty={dirty}
        isSaving={isSaving}
        onChange={handleMetaChange}
        onSave={() => void handleSave()}
      />

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
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-950 dark:text-gray-100"
        />
        <ScenarioEvSettingsFields
          className="bg-white dark:bg-gray-950"
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
          className="mb-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {saveError}
        </div>
      )}

      <div
        role="group"
        aria-label="Editor view"
        className="mb-4 inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm dark:border-gray-800 dark:bg-gray-950"
      >
        {(
          [
            ["steps", "Steps"],
            ["graph", "Graph"],
          ] as const
        ).map(([value, label]) => {
          const disabled = value === "steps" && !linear.isLinear;
          return (
            <button
              key={value}
              type="button"
              data-view={value}
              aria-pressed={view === value}
              disabled={disabled}
              title={
                disabled
                  ? "This scenario has branches or loops: the step list can only show a single chain"
                  : undefined
              }
              onClick={() => setView(value)}
              className={`rounded-md px-3 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                view === value
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {view === "graph" ? (
        <div className="h-[70vh] min-h-[480px] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
          <Suspense
            fallback={
              <div className="p-4 text-sm text-gray-500 dark:text-gray-400">
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
        <div className="flex gap-4">
          <div className="w-[380px] shrink-0">
            <StepList
              steps={linear.steps}
              selectedStepId={selectedStepId}
              onSelect={setSelectedStepId}
              onDelete={handleDelete}
              onMove={handleMove}
              onInsert={handleInsert}
            />
          </div>
          <div className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            {linear.isLinear && selectedNode ? (
              <StepInspector
                node={selectedNode}
                onChange={(data) => handleStepDataChange(selectedNode.id, data)}
              />
            ) : (
              <EmptyState
                title="Select a step"
                hint="Pick a step from the list on the left to edit its configuration."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ScenarioEditPage;
