import React, { useMemo } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import { deriveDisplayedSteps, stepSummary } from "../../../lib/scenarioSteps";
import type {
  ScenarioDefinition,
  ScenarioNode,
} from "../../../../cp/application/scenario/ScenarioTypes";
import { isLiveRunState } from "../../../lib/scenarioRunState";
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
 * live states (`isLiveRunState`) entirely (completed/error/stopped) — at which point
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
  if (nodeId === currentNodeId && isLiveRunState(state)) return "current";
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
  const { steps, isLinear } = useMemo(
    () => deriveDisplayedSteps(scenario),
    [scenario],
  );

  if (steps.length === 0) {
    return <p className="text-sm text-cx-muted">This scenario has no steps.</p>;
  }

  return (
    <div className="space-y-2">
      {!isLinear && (
        <div className="rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-xs text-cx-amber">
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
                status === "pending" && "border-cx-border opacity-60",
                status !== "pending" && !isFailedNode && "border-cx-border",
                status === "current" &&
                  !isFailedNode &&
                  "border-cx-accent bg-cx-sel",
                isFailedNode && "border-cx-rose bg-cx-rose/10",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  status === "pending" && "bg-cx-sub text-cx-muted",
                  status === "done" &&
                    !isFailedNode &&
                    "bg-cx-emerald/10 text-cx-emerald",
                  status === "current" &&
                    !isFailedNode &&
                    "animate-pulse bg-cx-sel text-cx-accent",
                  isFailedNode && "bg-cx-rose/10 text-cx-rose",
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
                <div className="truncate font-medium text-cx-fg">
                  {nodeTitle(step)}
                </div>
                <div className="truncate text-xs text-cx-muted">
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
