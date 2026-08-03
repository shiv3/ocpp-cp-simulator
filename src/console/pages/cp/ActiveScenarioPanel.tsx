import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import { useDataContext } from "../../../data/providers/DataProvider";
import { consolePath } from "../../routes";

interface ActiveScenarioPanelProps {
  cpId: string;
  connectorIds: number[];
}

const STATE_BADGE_STYLES: Record<
  "running" | "paused" | "stepping" | "waiting",
  string
> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  paused: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  stepping:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  waiting: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const ActiveScenarioPanel: React.FC<ActiveScenarioPanelProps> = ({
  cpId,
  connectorIds,
}) => {
  const { chargePointService } = useDataContext();
  const { runs, refresh } = useActiveScenarioRuns(cpId, connectorIds);

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
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
        Active scenarios
      </h3>

      <div className="space-y-2">
        {runs.map((run) => {
          const nodeStartedAt = run.currentNodeStartedAt ?? now;
          const elapsedMs = now - nodeStartedAt;
          const elapsed = formatElapsed(elapsedMs);

          let remainingMs: number | null = null;
          if (run.expectation?.timeoutMs) {
            remainingMs = Math.max(0, run.expectation.timeoutMs - elapsedMs);
          }
          const remaining =
            remainingMs !== null ? formatElapsed(remainingMs) : null;

          const payloadConditioned = Boolean(
            run.expectation?.constraints &&
            (run.expectation.constraints as Record<string, unknown>).payload,
          );
          const expectationDescription = `${
            run.expectation?.action ??
            run.expectation?.targetStatus ??
            run.expectation?.event ??
            run.expectation?.type
          }${payloadConditioned ? " (payload condition)" : ""}`;

          return (
            <div
              key={`${run.connectorId}:${run.scenarioId}`}
              className="flex flex-col gap-2 rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold",
                      STATE_BADGE_STYLES[run.state],
                    )}
                  >
                    {run.state}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {run.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
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

              <div className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span>
                  {run.currentNodeLabel || run.currentNodeId || "—"} (
                  {run.executedCount}/{run.nodeCount ?? "?"} steps)
                </span>
                <span>{elapsed}</span>
              </div>

              {run.state === "waiting" && run.expectation && (
                <div className="flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
                  <div>
                    Waiting for{" "}
                    <code className="font-mono text-xs bg-gray-200 px-1 py-0.5 rounded dark:bg-gray-700">
                      {expectationDescription}
                    </code>
                  </div>
                  {remaining !== null ? (
                    <div>Timeout in {remaining}</div>
                  ) : (
                    <div>No timeout</div>
                  )}
                </div>
              )}

              <Link
                to={consolePath(
                  `/scenarios/run?cp=${encodeURIComponent(cpId)}&connector=${run.connectorId}&id=${encodeURIComponent(run.scenarioId)}`,
                )}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
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
