import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDataContext } from "@/data/providers/DataProvider";

import RunStatePill from "../../components/RunStatePill";
import WaitControls from "../../components/WaitControls";
import WaitingExpectation from "../../components/WaitingExpectation";
import { formatElapsed } from "../../lib/scenarioExpectation";
import { buildScenarioUrl } from "../../lib/useAllScenarios";
import type { ActiveScenarioRun } from "../../lib/useActiveScenarioRuns";
import { controlScenarioWait } from "../../lib/waitControl";
import ConnectorScenarioSelect from "./ConnectorScenarioSelect";

export interface ConnectorRunRowProps {
  cpId: string;
  /** The selected connector, and every connector of the charge point: with
   *  no live run the row is the connector's scenario picker. */
  connectorId: number;
  connectorIds: number[];
  /** The live runs on the selected connector (usually one). */
  runs: ActiveScenarioRun[];
  /** Re-query the runs now / soon (from `useActiveScenarioRuns`). */
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
  /** Router state for the scenario-name link to the run panel: what the
   *  charge point page's Back link needs (`{ from }`). */
  runLinkState?: unknown;
}

/**
 * The scenario run executing on the selected connector, under its card: state,
 * name, `step k/N`, elapsed, Stop and, when the run is parked, what it waits
 * for with its wait controls (#240), plus the link to the run console (#366).
 * The scenario name opens the run in a side panel beside the full charge
 * point page (`/cp/<id>?connector=<n>&run=<scenarioId>`).
 * With no run live on the connector, the row is the connector's scenario
 * picker instead (`ConnectorScenarioSelect`: the Library scenario it uses,
 * **▶ Run**, **Apply to all connectors**). The runs come from the page's
 * single `useActiveScenarioRuns`, filtered by connector.
 */
const ConnectorRunRow: React.FC<ConnectorRunRowProps> = ({
  cpId,
  connectorId: selectedConnectorId,
  connectorIds,
  runs,
  refresh,
  scheduleRefresh,
  runLinkState,
}) => {
  const { chargePointService } = useDataContext();
  const [now, setNow] = useState<number>(Date.now());

  // The elapsed time and the wait countdown tick only while a run is live.
  useEffect(() => {
    if (runs.length === 0) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [runs.length]);

  const handleStop = useCallback(
    async (connectorId: number, scenarioId: string) => {
      try {
        await chargePointService.stopScenario(cpId, connectorId, scenarioId);
        await refresh();
      } catch (err) {
        console.error(
          `Failed to stop scenario ${scenarioId} on ${cpId}/${connectorId}`,
          err,
        );
      }
    },
    [cpId, chargePointService, refresh],
  );

  if (runs.length === 0) {
    return (
      <ConnectorScenarioSelect
        // Keyed: a connector switch starts from that connector's selection.
        key={selectedConnectorId}
        cpId={cpId}
        connectorId={selectedConnectorId}
        connectorIds={connectorIds}
        onRunStarted={scheduleRefresh}
      />
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {runs.map((run) => {
        const elapsed = formatElapsed(now - (run.currentNodeStartedAt ?? now));
        return (
          <div
            key={`${run.connectorId}:${run.scenarioId}`}
            data-testid="connector-run-row"
            data-run-id={run.runId}
            className="flex flex-col gap-2 rounded-[10px] border border-cx-border bg-cx-card px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <RunStatePill state={run.state} />
              <Link
                to={`/cp/${encodeURIComponent(cpId)}?connector=${
                  run.connectorId
                }&run=${encodeURIComponent(run.scenarioId)}`}
                state={runLinkState}
                title="Show the run beside the charge point"
                className="inline-flex items-center gap-0.5 font-medium text-cx-fg hover:text-cx-accent hover:underline"
              >
                {run.name}
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
              <span className="text-xs text-cx-muted">
                {run.currentNodeLabel || run.currentNodeId || "—"}{" "}
                <span className="font-mono">
                  {run.executedCount}/{run.nodeCount ?? "?"}
                </span>
              </span>
              <span className="font-mono text-xs text-cx-faint">{elapsed}</span>
              <div className="ml-auto flex items-center gap-3">
                <Link
                  // #366: carry the runId so the run page can tell whether the
                  // run it attaches to is still this one.
                  to={buildScenarioUrl(
                    "run",
                    cpId,
                    run.connectorId,
                    run.scenarioId,
                    { runId: run.runId },
                  )}
                  className="text-xs text-cx-accent hover:underline"
                >
                  Open run
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleStop(run.connectorId, run.scenarioId)}
                >
                  Stop
                </Button>
              </div>
            </div>

            {run.state === "waiting" && run.expectation && (
              <>
                <WaitingExpectation
                  expectation={run.expectation}
                  currentNodeStartedAt={run.currentNodeStartedAt}
                  waitDeadlineAt={run.waitDeadlineAt}
                  now={now}
                  className="text-xs text-cx-fg2"
                />
                <WaitControls
                  canExtend={run.waitDeadlineAt != null}
                  onControl={(action, seconds) =>
                    controlScenarioWait(
                      chargePointService,
                      cpId,
                      run.connectorId,
                      run.scenarioId,
                      action,
                      seconds,
                    ).then(scheduleRefresh)
                  }
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ConnectorRunRow;
