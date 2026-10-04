import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDataContext } from "@/data/providers/DataProvider";

import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import Combobox, { type ComboboxOption } from "../../components/Combobox";
import EmptyState from "../../components/EmptyState";
import RunStatePill from "../../components/RunStatePill";
import { statusDotClass } from "../../components/statusColor";
import { formatElapsed } from "../../lib/scenarioExpectation";
import { isLiveRunState, type LiveRunState } from "../../lib/scenarioRunState";
import type { ChargePointRun } from "../../lib/useAllActiveScenarioRuns";

export interface ActiveRunsTabProps {
  runs: ChargePointRun[];
  isLoading: boolean;
  /** Re-read the runs of every charge point (after a control). */
  refresh: () => Promise<void>;
  chargePoints: ChargePointSnapshot[];
  /** `ocppVersion` for a snapshot without `config` (Local mode). */
  ocppVersionFallback?: string;
}

// The tiles' order (the mock's), not the runtime's `LIVE_RUN_STATES` order.
const TILE_STATES = [
  "running",
  "waiting",
  "paused",
  "stepping",
] as const satisfies readonly LiveRunState[];

const runKey = (run: ChargePointRun) =>
  `${run.cpId}:${run.connectorId}:${run.scenarioId}`;

/**
 * The Scenarios page's Active runs tab: every live run of every charge point.
 * The per-state tiles are the state filter (counts always cover all runs),
 * the two comboboxes narrow by scenario name and charge point id. The
 * filters live in the URL (`?state=`, `?q=`, `?cp=`, replacing the history
 * entry) so a reload or a shared link shows the same list.
 *
 * Controls: Skip on a waiting run, Next on a stepping one, Stop on any. There
 * is no Pause / Resume: the service has no method to pause a run or to resume
 * a paused one, so a paused run only offers Stop.
 */
const ActiveRunsTab: React.FC<ActiveRunsTabProps> = ({
  runs,
  isLoading,
  refresh,
  chargePoints,
  ocppVersionFallback,
}) => {
  const { chargePointService } = useDataContext();
  const [params, setParams] = useSearchParams();
  const [now, setNow] = useState<number>(Date.now());
  // Per-row failure of the last action, keyed like the row.
  const [errors, setErrors] = useState<Record<string, string>>({});

  const stateParam = params.get("state") ?? "";
  const stateFilter: LiveRunState | "" = isLiveRunState(stateParam)
    ? stateParam
    : "";
  const nameFilter = params.get("q") ?? "";
  const cpFilter = params.get("cp") ?? "";

  const setParam = useCallback(
    (name: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value === "") next.delete(name);
      else next.set(name, value);
      // Replace: Back should leave the page, not undo each keystroke.
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // The elapsed time ticks only while a run is live.
  useEffect(() => {
    if (runs.length === 0) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [runs.length]);

  const counts = useMemo(() => {
    const byState: Record<LiveRunState, number> = {
      running: 0,
      waiting: 0,
      paused: 0,
      stepping: 0,
    };
    for (const run of runs) byState[run.state] += 1;
    return byState;
  }, [runs]);

  const shown = useMemo(() => {
    const name = nameFilter.toLowerCase();
    const cp = cpFilter.toLowerCase();
    return runs.filter(
      (run) =>
        (stateFilter === "" || run.state === stateFilter) &&
        (name === "" || run.name.toLowerCase().includes(name)) &&
        (cp === "" || run.cpId.toLowerCase().includes(cp)),
    );
  }, [runs, stateFilter, nameFilter, cpFilter]);

  const scenarioOptions = useMemo<ComboboxOption[]>(
    () =>
      [...new Set(runs.map((run) => run.name))]
        .sort()
        .map((value) => ({ value })),
    [runs],
  );
  const cpOptions = useMemo<ComboboxOption[]>(
    () =>
      chargePoints.map((cp) => ({
        value: cp.id,
        hint: cp.config?.ocppVersion ?? ocppVersionFallback,
        dot: statusDotClass(cp.status),
      })),
    [chargePoints, ocppVersionFallback],
  );

  const act = useCallback(
    async (run: ChargePointRun, what: string, call: () => Promise<void>) => {
      const key = runKey(run);
      setErrors((previous) => {
        const rest = { ...previous };
        delete rest[key];
        return rest;
      });
      try {
        await call();
        await refresh();
      } catch (err) {
        console.error(
          `Failed to ${what} scenario ${run.scenarioId} on ${run.cpId}/${run.connectorId}`,
          err,
        );
        setErrors((previous) => ({
          ...previous,
          [key]: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [refresh],
  );

  const tiles: Array<{ state: LiveRunState | ""; count: number }> = [
    { state: "", count: runs.length },
    ...TILE_STATES.map((state) => ({ state, count: counts[state] })),
  ];

  return (
    <div>
      <div
        role="group"
        aria-label="Run state"
        className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]"
      >
        {tiles.map(({ state, count }) => (
          <button
            key={state || "all"}
            type="button"
            data-state={state || "all"}
            aria-pressed={stateFilter === state}
            onClick={() => setParam("state", state)}
            className="flex flex-col items-start gap-1.5 rounded-[10px] border border-cx-border bg-cx-card px-3.5 py-3 text-left hover:border-cx-border-strong aria-pressed:border-cx-accent aria-pressed:bg-cx-sel"
          >
            {state ? (
              <RunStatePill state={state} />
            ) : (
              <span className="text-[12.5px] font-medium text-cx-fg2">All</span>
            )}
            <span className="text-2xl font-semibold leading-none tabular-nums text-cx-fg">
              {count}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Combobox
          id="active-runs-scenario"
          aria-label="Scenario"
          placeholder="Scenario"
          value={nameFilter}
          onChange={(value) => setParam("q", value)}
          options={scenarioOptions}
          className="w-52"
        />
        <Combobox
          id="active-runs-cp"
          aria-label="Charge point"
          placeholder="Charge point"
          value={cpFilter}
          onChange={(value) => setParam("cp", value)}
          options={cpOptions}
          className="w-44"
        />
        <span
          data-testid="active-runs-count"
          className="ml-auto text-xs text-cx-muted"
        >
          {shown.length} / {runs.length}
        </span>
      </div>

      {isLoading ? (
        <p className="text-sm text-cx-muted">Loading runs…</p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={
            runs.length === 0
              ? "No scenario is running."
              : "No active run matches the current filters."
          }
          hint={
            runs.length === 0
              ? "Start one from the Library tab or from a charge point."
              : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-cx-border bg-cx-card">
          {shown.map((run, index) => {
            const key = runKey(run);
            const elapsed = formatElapsed(
              now - (run.currentNodeStartedAt ?? now),
            );
            const progress =
              run.nodeCount && run.nodeCount > 0
                ? Math.min(100, (run.executedCount / run.nodeCount) * 100)
                : null;
            return (
              // A plain div: the run panel that opens from a row comes later.
              <div
                key={key}
                data-run-key={key}
                className={cn(
                  "px-4 py-3 hover:bg-cx-sub",
                  index > 0 && "border-t border-cx-border",
                )}
              >
                <div className="grid items-center gap-x-4 gap-y-2 md:grid-cols-[96px_1fr_1.3fr_130px]">
                  <RunStatePill state={run.state} />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-cx-fg">
                      {run.name}
                    </div>
                    <div className="truncate text-xs text-cx-muted">
                      <span className="font-mono">{run.cpId}</span> #
                      {run.connectorId}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-cx-fg2">
                      {run.currentNodeLabel || run.currentNodeId || "—"}
                    </div>
                    <div className="font-mono text-xs text-cx-faint">
                      {run.executedCount}/{run.nodeCount ?? "?"} · {elapsed}
                    </div>
                    {progress !== null && (
                      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-cx-sub">
                        <div
                          className="h-full bg-cx-accent"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    {run.state === "waiting" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void act(run, "skip the wait of", () =>
                            chargePointService.continueScenarioWait(
                              run.cpId,
                              run.connectorId,
                              run.scenarioId,
                            ),
                          )
                        }
                      >
                        Skip
                      </Button>
                    )}
                    {run.state === "stepping" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void act(run, "step", () =>
                            chargePointService.stepScenario(
                              run.cpId,
                              run.connectorId,
                              run.scenarioId,
                            ),
                          )
                        }
                      >
                        Next
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void act(run, "stop", () =>
                          chargePointService.stopScenario(
                            run.cpId,
                            run.connectorId,
                            run.scenarioId,
                          ),
                        )
                      }
                    >
                      Stop
                    </Button>
                  </div>
                </div>
                {errors[key] && (
                  <p role="alert" className="mt-2 text-xs text-cx-rose">
                    {errors[key]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ActiveRunsTab;
