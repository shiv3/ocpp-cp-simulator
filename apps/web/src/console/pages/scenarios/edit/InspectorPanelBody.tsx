import React from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  Repeat,
  RepeatOff,
  Trash2,
} from "lucide-react";

import type {
  ScenarioDefinition,
  ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import EmptyState from "../../../components/EmptyState";
import type { editCapabilities } from "../../../lib/blockTree";
import type { treeSteps } from "../../../lib/stepTree";
import { nodeTitle } from "../run/stepVisuals";
import { InspectorAction } from "./InspectorAction";
import StepInspector from "./StepInspector";

export interface InspectorPanelBodyProps {
  selectedNode: ScenarioDefinition["nodes"][number] | null;
  selectedNumber: number | null;
  caps: ReturnType<typeof editCapabilities> | null;
  showLink: boolean;
  selectedExit: string;
  allSteps: ReturnType<typeof treeSteps>;
  reachesSelected: Set<string>;
  numbers: ReadonlyMap<string, number>;
  numberOf: (nodeId: string) => number | string;
  laneFocus: { nodeId: string; handle: string; nonce: number } | null;
  scenario: ScenarioDefinition;
  onScenarioChange: React.Dispatch<
    React.SetStateAction<ScenarioDefinition | null>
  >;
  handleAddLane: (nodeId: string) => void;
  handleWrapInLoop: (nodeId: string) => void;
  handleUnwrapLoop: (nodeId: string) => void;
  handleMove: (nodeId: string, delta: number) => void;
  handleDelete: (nodeId: string) => void;
  handleLink: (nodeId: string, targetId: string | null) => void;
  handleStepDataChange: (nodeId: string, data: ScenarioNodeData) => void;
  showRangeOf: (nodeId: string | null) => void;
}

/** The inspector side panel's content: the selected step's actions, its
 *  jump select and its fields (or the empty state). */
export const InspectorPanelBody: React.FC<InspectorPanelBodyProps> = ({
  selectedNode,
  selectedNumber,
  caps,
  showLink,
  selectedExit,
  allSteps,
  reachesSelected,
  numbers,
  numberOf,
  laneFocus,
  scenario,
  onScenarioChange,
  handleAddLane,
  handleWrapInLoop,
  handleUnwrapLoop,
  handleMove,
  handleDelete,
  handleLink,
  handleStepDataChange,
  showRangeOf,
}) => {
  const { t } = useTranslation();
  return (
    <>
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
                  onHint={(on) => showRangeOf(on ? selectedNode.id : null)}
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
                title={caps.setLink.ok ? undefined : t(caps.setLink.reason)}
                onChange={(e) =>
                  handleLink(
                    selectedNode.id,
                    e.target.value === "" ? null : e.target.value,
                  )
                }
                className="rounded-md border border-cx-border-strong bg-cx-card px-2 py-1.5 text-sm text-cx-fg disabled:opacity-60"
              >
                <option value="">{t("scenarios.editor.endOfScenario")}</option>
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
              {!caps.setLink.ok && <span>{t(caps.setLink.reason)}</span>}
            </label>
          )}
          <StepInspector
            focusLane={laneFocus}
            node={selectedNode}
            onChange={(data) => handleStepDataChange(selectedNode.id, data)}
            scenario={scenario}
            onScenarioChange={onScenarioChange}
            stepNumbers={numbers}
          />
        </>
      ) : (
        <EmptyState
          title={t("scenarios.inspector.selectStep")}
          hint={t("scenarios.inspector.selectStepHint")}
        />
      )}
    </>
  );
};
