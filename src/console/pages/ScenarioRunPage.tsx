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
import { consolePath } from "../routes";
import { deriveDisplayedSteps } from "../lib/scenarioSteps";
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
 * `ChargePointService` layer, so this page only offers a Start/Stop toggle —
 * no Pause/Resume/Step affordance exists to wire up (see the `cpScope` and
 * "no Step button" notes below for why).
 *
 * Two dead-affordance fixes (console redesign review, Finding 3):
 * - Charge-point-scope scenarios (`targetType: "chargePoint"`, reached with
 *   an empty `connector` query param → `connectorId === null`) can't run
 *   through `useScenarioRun.start()`, which requires a numeric connectorId
 *   (`loadScenario` is connector-scoped). Start is disabled with an inline
 *   explanation for that case instead of silently no-op'ing.
 * - No Step button: see the comment above the Start/Stop button below.
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

  const { state, currentNodeId, executedNodeIds, error, start, stop, runs } =
    useScenarioRun(cpId || null, connectorId, scenario);

  // Charge-point-scope scenarios have no connectorId to load against —
  // `useScenarioRun.start()` early-returns on `connectorId == null` since
  // `loadScenario` needs a numeric connector. Rather than ship a Start
  // button that silently no-ops, disable it and explain why (see the
  // banner rendered below the header).
  const cpScopeScenario = connectorId == null;

  const view = useChargePointView(cpId || null);
  const tailLogs = useMemo(() => view.logs.slice(-LOG_TAIL_LIMIT), [view.logs]);

  // Same node set RunTimeline renders below — computing this independently
  // used to drift from the timeline's own derivation for branching
  // scenarios (the header did a partial `deriveLinearSteps` walk while the
  // timeline showed the full node list), so "step k/n" could disagree with
  // the list it sits above. See `deriveDisplayedSteps`.
  const displayedSteps = useMemo(
    () => (scenario ? deriveDisplayedSteps(scenario) : null),
    [scenario],
  );
  const totalSteps = displayedSteps?.steps.length ?? 0;
  const executedStepsCount = displayedSteps
    ? displayedSteps.steps.filter((s) => executedNodeIds.includes(s.id)).length
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
          to={consolePath("/scenarios")}
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
        to={consolePath("/scenarios")}
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
              disabled={!isRunning && cpScopeScenario}
              aria-describedby={
                cpScopeScenario ? "cp-scope-scenario-note" : undefined
              }
              onClick={() => void (isRunning ? stop() : start())}
            >
              {isRunning ? "Stop" : "Start"}
            </Button>
            {/* No Step button: `runScenario` always starts execution in
                oneshot mode — `ScenarioManager.executeScenario` is
                deliberately "always one-shot" (see its doc comment) and
                `service.ts`'s `runScenario` never threads a mode into
                `ScenarioExecutor.start()` either. The executor's internal
                "stepping" state (which `stepScenario`/`ScenarioExecutor.step`
                require) is therefore unreachable from this console, over
                both local and remote `ChargePointService` — a Step button
                here would be a dead control. Re-add once a code path exists
                that starts a run in step mode. */}
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

      {cpScopeScenario && (
        <div
          id="cp-scope-scenario-note"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          This is a charge-point-scope scenario — it runs automatically per
          connector when its trigger fires, not via a manual Start here. Start
          is disabled on this console.
        </div>
      )}

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
