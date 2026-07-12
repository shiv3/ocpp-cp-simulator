import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { LogViewer } from "@/components/ui/log-viewer";
import { cn } from "@/lib/utils";
import { useChargePointView } from "../../data/hooks/useChargePointView";
import { useDataContext } from "../../data/providers/DataProvider";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import TargetChip from "../components/TargetChip";
import { deriveLinearSteps } from "../lib/scenarioSteps";
import { useScenarioRun, type ScenarioRunState } from "../lib/useScenarioRun";
import RunHistory from "./scenarios/run/RunHistory";
import RunTimeline from "./scenarios/run/RunTimeline";

const LOG_TAIL_LIMIT = 200;

const RUN_STATE_STYLES: Record<ScenarioRunState, string> = {
  idle: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  error: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

/**
 * Scenario Run console (Task 8): a dedicated view that runs a scenario and
 * shows a live step timeline + correlated log tail + session run history —
 * deliberately separate from the editor. Reached via the "▶ Run" links
 * built by `buildScenarioUrl("run", cpId, connectorId, scenarioId)`
 * (`ScenarioMetaBar`, `ScenarioTable`).
 *
 * Execution goes through `useScenarioRun`, which mirrors the real
 * `loadScenario` → `runScenario` RPC sequence (see that hook's doc comment
 * for the full discovery notes). There is no pause/resume at the
 * `ChargePointService` layer, so this page only offers a Start/Stop toggle
 * plus Step — no Pause/Resume affordance exists to wire up.
 */
const ScenarioRunPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { chargePointService } = useDataContext();

  const cpId = searchParams.get("cp") ?? "";
  const connectorParam = searchParams.get("connector") ?? "";
  const connectorId = connectorParam === "" ? null : Number(connectorParam);
  const scenarioId = searchParams.get("id") ?? "";

  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);

    chargePointService
      .listScenarioDefinitions(cpId, connectorId)
      .then((defs) => {
        if (cancelled) return;
        const found = (defs ?? []).find((d) => d.id === scenarioId) ?? null;
        setScenario(found);
        setNotFound(!found);
      })
      .catch((err) => {
        console.error("Failed to load scenario definitions", err);
        if (!cancelled) {
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

  const {
    state,
    currentNodeId,
    executedNodeIds,
    error,
    start,
    stop,
    step,
    runs,
  } = useScenarioRun(cpId || null, connectorId, scenario);

  const view = useChargePointView(cpId || null);
  const tailLogs = useMemo(() => view.logs.slice(-LOG_TAIL_LIMIT), [view.logs]);

  const linear = useMemo(
    () => (scenario ? deriveLinearSteps(scenario) : null),
    [scenario],
  );
  const totalSteps = linear?.steps.length ?? 0;
  const executedStepsCount = linear
    ? linear.steps.filter((s) => executedNodeIds.includes(s.id)).length
    : 0;
  const stepLabel =
    state === "running" && totalSteps > 0
      ? ` · step ${Math.min(executedStepsCount + 1, totalSteps)}/${totalSteps}`
      : "";

  const isRunning = state === "running";

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        Loading…
      </div>
    );
  }

  if (notFound || !scenario) {
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
      <Link
        to="/scenarios"
        className="mb-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to scenarios
      </Link>

      <PageHeader
        title={scenario.name}
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant={isRunning ? "destructive" : "success"}
              onClick={() => void (isRunning ? stop() : start())}
            >
              {isRunning ? "Stop" : "Start"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!isRunning}
              onClick={() => void step()}
            >
              Step
            </Button>
          </>
        }
      >
        <TargetChip cpId={cpId} connectorId={connectorId} />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
            RUN_STATE_STYLES[state],
          )}
        >
          {state.charAt(0).toUpperCase() + state.slice(1)}
          {stepLabel}
        </span>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
            Timeline
          </h2>
          <RunTimeline
            scenario={scenario}
            currentNodeId={currentNodeId}
            executedNodeIds={executedNodeIds}
            state={state}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="h-[360px] rounded-xl border border-gray-200 dark:border-gray-800">
            <LogViewer logs={tailLogs} onClear={view.clearLogs} />
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              Run history
            </h2>
            <RunHistory runs={runs} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScenarioRunPage;
