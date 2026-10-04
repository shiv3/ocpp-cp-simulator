import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../../components/EmptyState";
import { LIVE_RUN_STATE_STYLES } from "../../lib/scenarioRunState";
import { deriveDisplayedSteps } from "../../lib/scenarioSteps";
import { deriveStepLayout, layoutSteps } from "../../lib/stepLayout";
import { buildScenarioUrl } from "../../lib/useAllScenarios";
import type { ChargePointRun } from "../../lib/useAllActiveScenarioRuns";
import RunTimeline from "./run/RunTimeline";
import StepsView from "./run/StepsView";

export interface ScenarioDefinitionPanelProps {
  cpId: string;
  /** The definition's scope: a connector, or null for the charge point. */
  connectorId: number | null;
  scenarioId: string;
  /** null while the library loads, or when the entry is gone. */
  scenario: ScenarioDefinition | null;
  isLoading: boolean;
  /** Every live run (the Scenarios page's `useAllActiveScenarioRuns`). */
  runs: ChargePointRun[];
  onClose: () => void;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A Library entry in the Scenarios page's side panel: what the scenario does
 * (its steps, no run state), where it runs right now (**Used by**: the
 * connectors with a live run of it), and **Edit scenario**.
 */
const ScenarioDefinitionPanel: React.FC<ScenarioDefinitionPanelProps> = ({
  cpId,
  connectorId,
  scenarioId,
  scenario,
  isLoading,
  runs,
  onClose,
}) => {
  const layout = useMemo(
    () => (scenario ? deriveStepLayout(scenario) : null),
    [scenario],
  );

  const closeButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="px-2"
      aria-label="Close side panel"
      title="Close (Esc)"
      onClick={onClose}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );

  if (!scenario || !layout) {
    return (
      <div>
        <div className="mb-2 flex justify-end">{closeButton}</div>
        {isLoading ? (
          <p className="text-sm text-cx-muted">Loading…</p>
        ) : (
          <EmptyState
            title="Scenario not found"
            hint={`No scenario "${scenarioId}" for ${cpId}.`}
          />
        )}
      </div>
    );
  }

  // A charge-point-scope scenario runs on any connector of its charge point.
  const usedBy = runs.filter(
    (run) =>
      run.cpId === cpId &&
      run.scenarioId === scenario.id &&
      (connectorId === null || run.connectorId === connectorId),
  );
  const branchCount = layout.fork?.branches.length ?? 0;
  const meta = layout.supported
    ? [
        plural(layoutSteps(layout).length, "step", "steps"),
        ...(branchCount > 0 ? [plural(branchCount, "branch", "branches")] : []),
      ].join(" · ")
    : `${plural(deriveDisplayedSteps(scenario).steps.length, "step", "steps")} · graph`;

  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-cx-fg">
            {scenario.name}
          </h2>
          <div className="mt-0.5 font-mono text-xs text-cx-muted">
            {cpId}
            {connectorId != null ? ` #${connectorId}` : " · charge point"}
            <span className="font-sans"> · {meta}</span>
          </div>
        </div>
        {closeButton}
      </div>

      {scenario.description && (
        <p className="mt-2 text-sm text-cx-fg2">{scenario.description}</p>
      )}

      <div className="mt-3">
        <Button asChild variant="outline" size="sm">
          <Link to={buildScenarioUrl("edit", cpId, connectorId, scenario.id)}>
            <Settings className="h-3.5 w-3.5" />
            Edit scenario
          </Link>
        </Button>
      </div>

      <div className="mt-4">
        <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-cx-muted">
          Used by
        </h3>
        {usedBy.length === 0 ? (
          <p className="text-sm text-cx-muted">no connector running it</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {usedBy.map((run) => (
              <Link
                key={`${run.cpId}:${run.connectorId}`}
                to={`/cp/${encodeURIComponent(run.cpId)}?connector=${run.connectorId}`}
                title={run.state}
                className="inline-flex items-center gap-1.5 rounded-md border border-cx-border bg-cx-card px-2 py-0.5 font-mono text-xs text-cx-fg2 hover:border-cx-border-strong hover:text-cx-fg"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-[7px] w-[7px] rounded-full",
                    LIVE_RUN_STATE_STYLES[run.state],
                  )}
                />
                {run.cpId} #{run.connectorId}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5">
        {layout.supported ? (
          <StepsView layout={layout} />
        ) : (
          <RunTimeline
            scenario={scenario}
            currentNodeId={null}
            executedNodeIds={[]}
            state="idle"
          />
        )}
      </div>
    </div>
  );
};

export default ScenarioDefinitionPanel;
