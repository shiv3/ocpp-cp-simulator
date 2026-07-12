import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { saveEditorScenario } from "../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../components/scenario/scenarioSerialize";
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
 * Linear scenario editor (Task 7): an ordered step list + schema-driven
 * inspector, replacing the ReactFlow graph editor for scenarios that form a
 * single START→…→END chain. Non-linear scenarios (branches) are shown
 * read-only with a link back to the classic graph editor — see the
 * `deriveLinearSteps(...).isLinear` guard below.
 */
const ScenarioEditPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { mode, chargePointService } = useDataContext();

  const cpId = searchParams.get("cp") ?? "";
  const connectorParam = searchParams.get("connector") ?? "";
  const connectorId = connectorParam === "" ? null : Number(connectorParam);
  const scenarioId = searchParams.get("id") ?? "";

  const [original, setOriginal] = useState<ScenarioDefinition | null>(null);
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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

  const handleSave = async () => {
    if (!scenario) return;
    setIsSaving(true);
    try {
      await saveEditorScenario(
        { mode, chargePointService, cpId, connectorId },
        scenario,
      );
      setOriginal(scenario);
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
          to="/scenarios"
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

      {!linear.isLinear && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This scenario has branches — edit it in the classic graph editor.{" "}
          <Link to="/v2" className="font-medium underline">
            Open classic editor
          </Link>
        </div>
      )}

      <div className="flex gap-4">
        <div className="w-[380px] shrink-0">
          <StepList
            steps={linear.steps}
            selectedStepId={selectedStepId}
            onSelect={setSelectedStepId}
            onDelete={handleDelete}
            onMove={handleMove}
            onInsert={handleInsert}
            readOnly={!linear.isLinear}
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
    </div>
  );
};

export default ScenarioEditPage;
