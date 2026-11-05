import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { useDataContext } from "@/data/providers/DataProvider";
import { cn } from "@/lib/utils";
import { loadPersistedScenarioIntoRuntime } from "../../../components/scenario/scenarioPersistence";

import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import RunStatePill from "../../components/RunStatePill";
import WaitControls from "../../components/WaitControls";
import WaitingExpectation from "../../components/WaitingExpectation";
import { formatElapsed } from "../../lib/scenarioExpectation";
import {
  assignLibraryScenario,
  assignedLibraryId,
  editScenarioUrl,
  listScopeDefinitions,
  LIBRARY_SCOPE,
} from "../../lib/scenarioLibrary";
import type { ActiveScenarioRun } from "../../lib/useActiveScenarioRuns";
import { buildScenarioUrl } from "../../lib/useAllScenarios";
import { useScopeDefinitions } from "../../lib/useScenarioLibrary";
import { controlScenarioWait } from "../../lib/waitControl";

export interface ScenarioCardProps {
  cpId: string;
  connectorId: number;
  /** Every connector of the charge point, for **Use on all N connectors**. */
  connectorIds: number[];
  /** The live runs on this connector (usually one). */
  runs: ActiveScenarioRun[];
  /** Re-query the runs now / soon (from `useActiveScenarioRuns`). */
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
  /** Router state for the scenario-name link to the run panel: what the
   *  charge point page's Back link needs (`{ from }`). */
  runLinkState?: unknown;
}

/** Value of the option standing for a definition that is not a Library copy
 *  (loaded by hand, or not migrated yet). */
const UNLISTED = "__unlisted__";
const NOTE_MS = 2000;

const CARD =
  "mt-2.5 rounded-[10px] border border-cx-border bg-cx-card px-[18px] py-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none";

/** A live run: name (to the run panel), state, `step k of N · step ·
 *  elapsed`, Open run and Stop, a progress bar, the wait controls when it
 *  waits (#240). */
const LiveRun: React.FC<{
  cpId: string;
  run: ActiveScenarioRun;
  now: number;
  runLinkState?: unknown;
  onStop: () => void;
  scheduleRefresh: () => void;
}> = ({ cpId, run, now, runLinkState, onStop, scheduleRefresh }) => {
  const { chargePointService } = useDataContext();
  const elapsed = formatElapsed(now - (run.currentNodeStartedAt ?? now));
  const progress =
    run.nodeCount && run.nodeCount > 0
      ? Math.min(100, (run.executedCount / run.nodeCount) * 100)
      : 0;
  return (
    <div
      data-testid="scenario-run"
      data-run-id={run.runId}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <h3 className="font-semibold text-cx-fg">
          <Link
            to={`/cp/${encodeURIComponent(cpId)}?connector=${
              run.connectorId
            }&run=${encodeURIComponent(run.scenarioId)}`}
            state={runLinkState}
            title="Show the run beside the charge point"
            className="inline-flex items-center gap-0.5 hover:text-cx-accent hover:underline"
          >
            {run.name}
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </h3>
        <RunStatePill state={run.state} />
        <span className="text-[12.5px] text-cx-muted">
          step {run.executedCount} of {run.nodeCount ?? "?"} ·{" "}
          {run.currentNodeLabel || run.currentNodeId || "—"} ·{" "}
          <span className="font-mono">{elapsed}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Link
            // #366: carry the runId so the run page can tell whether the run
            // it attaches to is still this one.
            to={buildScenarioUrl("run", cpId, run.connectorId, run.scenarioId, {
              runId: run.runId,
            })}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open run
          </Link>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onStop}
          >
            Stop
          </Button>
        </span>
      </div>
      <div
        role="progressbar"
        data-testid="scenario-progress"
        aria-label="Scenario progress"
        aria-valuemin={0}
        aria-valuemax={run.nodeCount ?? undefined}
        aria-valuenow={run.executedCount}
        className="h-[3px] overflow-hidden rounded-sm bg-cx-sub"
      >
        <div
          className="h-full rounded-sm bg-cx-accent"
          style={{ width: `${progress}%` }}
        />
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
};

/** No live run: the connector's Library scenario, **▶ Run**, **Edit in
 *  Library** and **Use on all N connectors**. Choosing a scenario assigns it
 *  at once (the connector's persisted set becomes one copy of it), so what
 *  the select shows is what auto-start and Run use. */
const ScenarioPicker: React.FC<{
  cpId: string;
  connectorId: number;
  connectorIds: number[];
  onRunStarted: () => void;
}> = ({ cpId, connectorId, connectorIds, onRunStarted }) => {
  const { chargePointService } = useDataContext();
  const library = useScopeDefinitions(LIBRARY_SCOPE, null);
  const scope = useScopeDefinitions(cpId, connectorId);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  const showNote = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const assigned = assignedLibraryId(scope.definitions);
  const assignedScenario = assigned
    ? library.definitions.find((d) => d.id === assigned)
    : undefined;
  // The definition Run starts: the Library copy, else whatever the connector
  // holds (a scenario loaded by hand still runs).
  const current = assigned
    ? scope.definitions.find((d) => d.libraryId === assigned)
    : scope.definitions[0];
  const unlisted = !assigned ? scope.definitions[0] : undefined;
  const value = assigned ?? (unlisted ? UNLISTED : "");

  const fail = (message: string, err: unknown) => {
    console.error(message, err);
    setError(`${message}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const handleChange = async (next: string) => {
    if (next === UNLISTED) return;
    setError(null);
    setBusy(true);
    try {
      const scenario = next
        ? (library.definitions.find((d) => d.id === next) ?? null)
        : null;
      await assignLibraryScenario(
        chargePointService,
        cpId,
        connectorId,
        scenario,
      );
      await scope.refresh();
      showNote("Scenario set");
    } catch (err) {
      fail("Failed to set the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    if (!current) return;
    setError(null);
    setBusy(true);
    try {
      try {
        await chargePointService.runScenario(cpId, connectorId, current.id);
      } catch (err) {
        // The copy is persisted; a runtime that has not picked it up yet
        // (e.g. the charge point was instantiated before the assignment) gets
        // it loaded, then runs it.
        if (!/not found/i.test(err instanceof Error ? err.message : "")) {
          throw err;
        }
        await loadPersistedScenarioIntoRuntime(
          chargePointService,
          cpId,
          connectorId,
          current,
        );
        await chargePointService.runScenario(cpId, connectorId, current.id);
      }
      onRunStarted();
    } catch (err) {
      fail("Failed to run the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  const handleUseOnAll = async () => {
    if (!assignedScenario) return;
    setError(null);
    try {
      const others = connectorIds.filter((id) => id !== connectorId);
      const sets = await Promise.all(
        others.map((id) => listScopeDefinitions(chargePointService, cpId, id)),
      );
      const replaced = others.filter(
        (_, i) => sets[i].length > 0 && assignedLibraryId(sets[i]) !== assigned,
      );
      if (
        replaced.length > 0 &&
        typeof window !== "undefined" &&
        !window.confirm(
          `Use "${assignedScenario.name}" on every connector of ${cpId}? It replaces the scenario of ${
            replaced.length === 1 ? "connector" : "connectors"
          } ${replaced.join(", ")}.`,
        )
      ) {
        return;
      }
      setBusy(true);
      await Promise.all(
        connectorIds.map((id) =>
          assignLibraryScenario(chargePointService, cpId, id, assignedScenario),
        ),
      );
      await scope.refresh();
      showNote(`Scenario set on ${connectorIds.length} connectors`);
    } catch (err) {
      fail("Failed to apply the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="font-semibold text-cx-fg">No scenario running</h3>
        <span className="text-[12.5px] text-cx-muted">
          Pick one from the Library to run on this connector.
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Scenario for connector ${connectorId}`}
          value={value}
          disabled={busy || library.isLoading}
          onChange={(e) => void handleChange(e.target.value)}
          className={cn(FILTER_SELECT_CLASS, "min-w-[220px] max-w-full")}
        >
          <option value="">None</option>
          {unlisted && (
            <option value={UNLISTED} disabled>
              {unlisted.name} (not in the Library)
            </option>
          )}
          {library.definitions.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          disabled={!current || busy}
          onClick={() => void handleRun()}
        >
          ▶ Run
        </Button>
        {current && (
          <Link
            to={editScenarioUrl(cpId, connectorId, current)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Edit in Library
          </Link>
        )}
        {note && (
          <span role="status" className="text-xs text-cx-emerald">
            {note}
          </span>
        )}
        {connectorIds.length > 1 && (
          <button
            type="button"
            disabled={!assignedScenario || busy}
            onClick={() => void handleUseOnAll()}
            title="Assign this Library scenario to every connector of the charge point"
            className="ml-auto text-[12.5px] text-cx-accent hover:underline disabled:text-cx-faint disabled:no-underline"
          >
            Use on all {connectorIds.length} connectors
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-cx-rose">
          {error}
        </p>
      )}
    </>
  );
};

/**
 * The scenario card under a connector card: the run executing (or parked) on
 * the connector, with the link to its run panel and the run console (#366), or
 * with no run live, the connector's Library scenario and **▶ Run**. The runs
 * come from the page's single `useActiveScenarioRuns`, filtered by connector.
 */
const ScenarioCard: React.FC<ScenarioCardProps> = ({
  cpId,
  connectorId,
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
    async (runConnectorId: number, scenarioId: string) => {
      try {
        await chargePointService.stopScenario(cpId, runConnectorId, scenarioId);
        await refresh();
      } catch (err) {
        console.error(
          `Failed to stop scenario ${scenarioId} on ${cpId}/${runConnectorId}`,
          err,
        );
      }
    },
    [cpId, chargePointService, refresh],
  );

  return (
    <section
      data-testid="scenario-card"
      data-connector-id-ref={connectorId}
      aria-label={`Scenario on connector ${connectorId}`}
      className={CARD}
    >
      {runs.length === 0 ? (
        <ScenarioPicker
          // Keyed: a connector switch starts from that connector's selection.
          key={connectorId}
          cpId={cpId}
          connectorId={connectorId}
          connectorIds={connectorIds}
          onRunStarted={scheduleRefresh}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {runs.map((run) => (
            <LiveRun
              key={`${run.connectorId}:${run.scenarioId}`}
              cpId={cpId}
              run={run}
              now={now}
              runLinkState={runLinkState}
              scheduleRefresh={scheduleRefresh}
              onStop={() => void handleStop(run.connectorId, run.scenarioId)}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export default ScenarioCard;
