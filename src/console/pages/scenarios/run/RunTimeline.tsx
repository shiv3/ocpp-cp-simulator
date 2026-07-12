import React, { useMemo } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import { deriveLinearSteps, stepSummary } from "../../../lib/scenarioSteps";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../../../../cp/application/scenario/ScenarioTypes";
import type { ScenarioRunState } from "../../../lib/useScenarioRun";

export interface RunTimelineProps {
  scenario: ScenarioDefinition;
  currentNodeId: string | null;
  executedNodeIds: string[];
  state: ScenarioRunState;
}

type StepStatus = "done" | "current" | "pending";

/**
 * There's no `scenario-node-complete`/`scenario-node-progress` event (only
 * `scenario-node-execute`), so a step only ever reads "done" once a LATER
 * node-execute event supersedes it as `currentNodeId`, or the run leaves the
 * "running" state entirely (completed/error/stopped) — at which point
 * whatever was still "current" settles into "done" too. No fractional
 * progress bar is possible without a progress event.
 */
function stepStatus(
  nodeId: string,
  currentNodeId: string | null,
  executedNodeIds: readonly string[],
  state: ScenarioRunState,
): StepStatus {
  if (!executedNodeIds.includes(nodeId)) return "pending";
  if (nodeId === currentNodeId && state === "running") return "current";
  return "done";
}

function nodeTitle(node: ScenarioNode): string {
  const entry = isScenarioNodeType(node.type)
    ? NODE_FORM_REGISTRY[node.type]
    : undefined;
  return entry?.title ?? node.type ?? "Step";
}

/**
 * Read-only run view of a scenario's steps (Task 8's counterpart to the
 * editor's `StepList`). Linear scenarios use `deriveLinearSteps`'s ordered
 * walk; branching scenarios fall back to a flat list of every non-START/END
 * node in definition order, flagged with a banner since that order is only
 * approximate (the real execution order depends on which edge fires).
 */
const RunTimeline: React.FC<RunTimelineProps> = ({
  scenario,
  currentNodeId,
  executedNodeIds,
  state,
}) => {
  const linear = useMemo(() => deriveLinearSteps(scenario), [scenario]);
  const steps = linear.isLinear
    ? linear.steps
    : scenario.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      );

  if (steps.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        This scenario has no steps.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!linear.isLinear && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          branching scenario — order approximate
        </div>
      )}
      <ol className="space-y-1.5">
        {steps.map((step, index) => {
          const status = stepStatus(
            step.id,
            currentNodeId,
            executedNodeIds,
            state,
          );
          const isFailedNode = state === "error" && step.id === currentNodeId;

          return (
            <li
              key={step.id}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-sm",
                status === "pending" &&
                  "border-gray-200 opacity-60 dark:border-gray-800",
                status !== "pending" &&
                  !isFailedNode &&
                  "border-gray-200 dark:border-gray-800",
                status === "current" &&
                  !isFailedNode &&
                  "border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40",
                isFailedNode &&
                  "border-rose-400 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/40",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  status === "pending" &&
                    "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
                  status === "done" &&
                    !isFailedNode &&
                    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
                  status === "current" &&
                    !isFailedNode &&
                    "animate-pulse bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
                  isFailedNode &&
                    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
                )}
                aria-label={
                  isFailedNode ? "failed" : status === "done" ? "done" : status
                }
              >
                {isFailedNode ? (
                  "!"
                ) : status === "done" ? (
                  <Check className="h-3 w-3" />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900 dark:text-gray-100">
                  {nodeTitle(step)}
                </div>
                <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {stepSummary(step)}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default RunTimeline;
