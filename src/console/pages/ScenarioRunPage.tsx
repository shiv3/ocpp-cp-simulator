import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { LogViewer } from "@/components/ui/log-viewer";
import { useChargePointView } from "../../data/hooks/useChargePointView";
import { useDataContext } from "../../data/providers/DataProvider";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import RunStatePill from "../components/RunStatePill";
import TargetChip from "../components/TargetChip";
import WaitControls from "../components/WaitControls";
import WaitingExpectation from "../components/WaitingExpectation";
import { isLiveRunState } from "../lib/scenarioRunState";
import { deriveDisplayedSteps } from "../lib/scenarioSteps";
import { useScenarioRun } from "../lib/useScenarioRun";
import { useScenarioRunHistory } from "../lib/useScenarioRunHistory";
import { mergeRunHistory, runRowKey } from "../lib/runHistoryRows";
import { buildRunHistoryUrl } from "../lib/useAllScenarios";
import RunHistory from "./scenarios/run/RunHistory";
import RunReportView from "./scenarios/run/RunReportView";
import RunTimeline from "./scenarios/run/RunTimeline";

const LOG_TAIL_LIMIT = 200;
/** How many recorded runs the panel lists; the run history page has the rest. */
const RECORDED_RUNS_LIMIT = 20;

/**
 * Scenario Run console (Task 8): a dedicated view that runs a scenario and
 * shows a live step timeline + correlated log tail + run history —
 * deliberately separate from the editor. Reached via the "▶ Run" links
 * built by `buildScenarioUrl("run", cpId, connectorId, scenarioId)`
 * (`ScenarioMetaBar`, `ScenarioTable`), and by the CP page's Active
 * scenarios "Open run" link, which adds `&run=<runId>`.
 *
 * The page attaches to a run that is already live in the runtime (#366):
 * `useScenarioRun` hydrates state, current node, executed nodes, waiting
 * expectation and runId from `getScenarioStatus`, so opening or reloading
 * this URL mid-run shows that run — it never starts one. When the `run`
 * param names a run that is no longer the live one, a banner says so.
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
  const requestedRunId = searchParams.get("run");

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
    runId,
    expectation,
    currentNodeStartedAt,
    waitDeadlineAt,
    hydrated,
    start,
    stop,
    controlWait,
    runs,
  } = useScenarioRun(cpId || null, connectorId, scenario);

  const isRunning = isLiveRunState(state);

  // #388: the daemon's recorded runs of this target, so the history outlives
  // this page view; the runs the page tracked itself fill in the live one
  // (and every run in local mode, which records none).
  const recorded = useScenarioRunHistory(
    cpId && connectorId != null && scenarioId
      ? { cpId, connectorId, scenarioId, limit: RECORDED_RUNS_LIMIT }
      : null,
    cpId ? [cpId] : [],
  );
  const historyRows = useMemo(
    () => mergeRunHistory(runs, recorded.page.runs),
    [runs, recorded.page.runs],
  );
  // The selection belongs to the viewed target: under another one it reads
  // as none at once, so no report is fetched for the old run.
  const target = `${cpId}\n${connectorParam}\n${scenarioId}`;
  const [selection, setSelection] = useState({
    target,
    runId: null as string | null,
  });
  const selectedRunId = selection.target === target ? selection.runId : null;

  // The run named in the URL ("Open run") has ended or been superseded by
  // another run of the same scenario. Unknowable without a runtime runId
  // (local mode), so no banner there.
  const requestedRunGone =
    hydrated &&
    !!requestedRunId &&
    (!isRunning || (runId != null && runId !== requestedRunId));

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
    isRunning && totalSteps > 0
      ? ` · step ${Math.min(executedStepsCount + 1, totalSteps)}/${totalSteps}`
      : "";

  if (isLoading) {
    return <div className="p-6 text-sm text-cx-muted">Loading…</div>;
  }

  if (notFound || !scenario) {
    return (
      <div className="p-6">
        <Link
          to={"/scenarios"}
          className="mb-4 inline-block text-sm text-cx-accent hover:underline"
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
        to={"/scenarios"}
        className="mb-2 inline-block text-sm text-cx-accent hover:underline"
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
        <RunStatePill
          state={state}
          label={state.charAt(0).toUpperCase() + state.slice(1)}
        >
          {stepLabel}
        </RunStatePill>
        {runId && (
          <span
            className="font-mono text-xs text-cx-muted"
            title="Runtime run id"
          >
            {runId}
          </span>
        )}
      </PageHeader>

      {requestedRunGone && (
        <div className="mb-4 rounded-md border border-cx-accent/40 bg-cx-accent/10 px-3 py-2 text-sm text-cx-accent">
          Run {requestedRunId} is no longer active
          {isRunning && runId ? ` — showing the current run ${runId}.` : "."}
        </div>
      )}

      {state === "waiting" && expectation && (
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-amber">
          <WaitingExpectation
            expectation={expectation}
            currentNodeStartedAt={currentNodeStartedAt}
            waitDeadlineAt={waitDeadlineAt}
          />
          <WaitControls
            canExtend={waitDeadlineAt != null}
            onControl={controlWait}
          />
        </div>
      )}

      {cpScopeScenario && (
        <div
          id="cp-scope-scenario-note"
          className="mb-4 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-amber"
        >
          This is a charge-point-scope scenario — it runs automatically per
          connector when its trigger fires, not via a manual Start here. Start
          is disabled on this console.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-sm text-cx-rose">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4">
          <h2 className="mb-3 text-sm font-semibold text-cx-fg2">Timeline</h2>
          <RunTimeline
            scenario={scenario}
            currentNodeId={currentNodeId}
            executedNodeIds={executedNodeIds}
            state={state}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="h-[360px] rounded-xl border border-cx-border">
            <LogViewer logs={tailLogs} onClear={view.clearLogs} />
          </div>
          <div className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-cx-fg2">Run history</h2>
              {recorded.supported && (
                <Link
                  to={buildRunHistoryUrl(cpId, connectorId, scenarioId)}
                  className="text-xs text-cx-accent hover:underline"
                >
                  View all runs
                </Link>
              )}
            </div>
            {recorded.error && (
              <p className="mb-2 text-xs text-cx-rose">
                Could not load the recorded runs: {recorded.error}
              </p>
            )}
            <RunHistory
              rows={historyRows}
              emptyText={
                recorded.supported
                  ? "No runs recorded yet."
                  : "No runs yet this session."
              }
              selectedKey={
                selectedRunId ? runRowKey(cpId, selectedRunId) : null
              }
              onSelect={(row) =>
                setSelection({
                  target,
                  runId:
                    selectedRunId === row.runId ? null : (row.runId ?? null),
                })
              }
            />
            {selectedRunId && connectorId != null && (
              <div className="mt-4 border-t border-cx-border pt-4">
                <RunReportView
                  cpId={cpId}
                  connectorId={connectorId}
                  scenarioId={scenarioId}
                  runId={selectedRunId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScenarioRunPage;
