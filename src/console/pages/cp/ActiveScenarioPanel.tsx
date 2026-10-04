import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import WaitControls from "../../components/WaitControls";
import WaitingExpectation from "../../components/WaitingExpectation";
import { formatElapsed } from "../../lib/scenarioExpectation";
import RunStatePill from "../../components/RunStatePill";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import { controlScenarioWait } from "../../lib/waitControl";
import { buildScenarioUrl } from "../../lib/useAllScenarios";
import { useDataContext } from "../../../data/providers/DataProvider";

interface ActiveScenarioPanelProps {
  cpId: string;
  connectorIds: number[];
}

const ActiveScenarioPanel: React.FC<ActiveScenarioPanelProps> = ({
  cpId,
  connectorIds,
}) => {
  const { chargePointService } = useDataContext();
  const { runs, refresh, scheduleRefresh } = useActiveScenarioRuns(
    cpId,
    connectorIds,
  );

  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    if (runs.length === 0) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

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
    return null;
  }

  return (
    <div className="mb-6 rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4">
      <h3 className="mb-3 text-sm font-semibold text-cx-fg">
        Active scenarios
      </h3>

      <div className="space-y-2">
        {runs.map((run) => {
          const nodeStartedAt = run.currentNodeStartedAt ?? now;
          const elapsedMs = now - nodeStartedAt;
          const elapsed = formatElapsed(elapsedMs);

          return (
            <div
              key={`${run.connectorId}:${run.scenarioId}`}
              className="flex flex-col gap-2 rounded-md border border-cx-border bg-cx-sub p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <RunStatePill state={run.state} />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-cx-fg">{run.name}</span>
                    <span className="text-xs text-cx-muted">
                      Connector #{run.connectorId}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleStop(run.connectorId, run.scenarioId)}
                  className="h-7 text-xs"
                >
                  Stop
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs text-cx-fg2">
                <span>
                  {run.currentNodeLabel || run.currentNodeId || "—"} (
                  {run.executedCount}/{run.nodeCount ?? "?"} steps)
                </span>
                <span>{elapsed}</span>
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
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActiveScenarioPanel;
