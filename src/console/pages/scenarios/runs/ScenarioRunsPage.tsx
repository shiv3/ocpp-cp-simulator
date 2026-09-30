import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  SCENARIO_RUN_EXECUTION_STATES,
  SCENARIO_VERDICTS,
  type ScenarioRunQuery,
} from "../../../../cp/application/verification/ScenarioRunSummary";
import { SCENARIO_RUNS_PAGE_DEFAULT } from "../../../../protocol";
import { useChargePoints } from "../../../../data/hooks/useChargePoints";
import { useConfig } from "../../../../data/hooks/useConfig";
import EmptyState from "../../../components/EmptyState";
import {
  FILTER_INPUT_CLASS,
  FILTER_SELECT_CLASS,
} from "../../../components/filterStyles";
import PageHeader from "../../../components/PageHeader";
import { summaryToRow } from "../../../lib/runHistoryRows";
import { useScenarioRunHistory } from "../../../lib/useScenarioRunHistory";
import RunHistory from "../run/RunHistory";
import RunReportView from "../run/RunReportView";

const PAGE_SIZE = SCENARIO_RUNS_PAGE_DEFAULT;

function oneOf<T extends string>(
  values: readonly T[],
  value: string | null,
): T | undefined {
  return values.find((v) => v === value);
}

/** The listing query the URL describes; unknown values are dropped. */
function queryFromParams(params: URLSearchParams): ScenarioRunQuery {
  const connector = Number(params.get("connector"));
  return {
    cpId: params.get("cp") || undefined,
    connectorId:
      Number.isInteger(connector) && connector >= 1 ? connector : undefined,
    scenarioId: params.get("scenario") || undefined,
    verdict: oneOf(SCENARIO_VERDICTS, params.get("verdict")),
    executionState: oneOf(SCENARIO_RUN_EXECUTION_STATES, params.get("state")),
  };
}

/**
 * Run history (#388): every scenario run the daemon recorded, across charge
 * points, newest first — filtered and paged by the daemon
 * (`scenario.runs.list`), with the selected run's report beside the list.
 * Filters and the selected run live in the URL (`?cp=&connector=&scenario=
 * &verdict=&state=&run=`), so a view can be linked; the run page's "View all
 * runs" link opens it filtered on that scenario. Local mode records no runs.
 */
const ScenarioRunsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { config, isLoading: configLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, {
    isLoading: configLoading,
  });
  // The page offset belongs to one set of filters: under new filters it reads
  // as 0 at once, so the first query already asks for the first page.
  const [paging, setPaging] = useState({ filterKey: "", offset: 0 });

  const filters = queryFromParams(searchParams);
  const filterKey = JSON.stringify(filters);
  const offset = paging.filterKey === filterKey ? paging.offset : 0;
  const setOffset = (next: number) => setPaging({ filterKey, offset: next });

  const { page, isLoading, error, supported, refresh } = useScenarioRunHistory(
    { ...filters, limit: PAGE_SIZE, offset },
    // Only the filtered charge point can record a run this list shows.
    filters.cpId ? [filters.cpId] : chargePoints.map((cp) => cp.id),
  );
  const rows = useMemo(() => page.runs.map(summaryToRow), [page.runs]);
  const selectedRunId = searchParams.get("run");
  const selected = page.runs.find((r) => r.runId === selectedRunId) ?? null;

  // The history shrank under the current page (retention, `cp.delete`,
  // `state.reset`): step back to its last page instead of showing an empty one.
  const lastPageOffset =
    page.total === 0 ? 0 : Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE;
  useEffect(() => {
    if (!isLoading && offset > lastPageOffset) {
      setPaging({ filterKey, offset: lastPageOffset });
    }
  }, [isLoading, offset, lastPageOffset, filterKey]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "run") next.delete("run");
    // Editing a filter replaces the history entry: typing a scenario id must
    // not leave one Back step per keystroke. Selecting a run is navigation.
    setSearchParams(next, { replace: key !== "run" });
  };

  if (!supported) {
    return (
      <div className="p-6">
        <PageHeader title="Run History" />
        <EmptyState
          title="Run history needs the simulator daemon"
          hint="Local mode runs scenarios in the browser and records no run history. Connect the console to a daemon (remote mode) to browse recorded runs."
        />
      </div>
    );
  }

  const first = page.total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + page.runs.length, page.total);

  return (
    <div className="p-6">
      <PageHeader
        title="Run History"
        count={`${page.total} run${page.total === 1 ? "" : "s"}`}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isLoading}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={filters.cpId ?? ""}
          onChange={(e) => setParam("cp", e.target.value)}
          className={FILTER_SELECT_CLASS}
          aria-label="Filter by charge point"
        >
          <option value="">All charge points</option>
          {chargePoints.map((cp) => (
            <option key={cp.id} value={cp.id}>
              {cp.id}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          value={filters.connectorId ?? ""}
          onChange={(e) => setParam("connector", e.target.value)}
          placeholder="Connector"
          aria-label="Filter by connector"
          className={`${FILTER_INPUT_CLASS} w-28`}
        />
        <input
          type="text"
          value={filters.scenarioId ?? ""}
          onChange={(e) => setParam("scenario", e.target.value)}
          placeholder="Scenario id"
          aria-label="Filter by scenario id"
          className={FILTER_INPUT_CLASS}
        />
        <select
          value={filters.verdict ?? ""}
          onChange={(e) => setParam("verdict", e.target.value)}
          className={FILTER_SELECT_CLASS}
          aria-label="Filter by verdict"
        >
          <option value="">All verdicts</option>
          {SCENARIO_VERDICTS.map((verdict) => (
            <option key={verdict} value={verdict}>
              {verdict}
            </option>
          ))}
        </select>
        <select
          value={filters.executionState ?? ""}
          onChange={(e) => setParam("state", e.target.value)}
          className={FILTER_SELECT_CLASS}
          aria-label="Filter by execution state"
        >
          <option value="">All execution states</option>
          {SCENARIO_RUN_EXECUTION_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="mb-4 text-sm text-rose-700 dark:text-rose-300">
          Could not load the run history: {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <RunHistory
            rows={rows}
            emptyText="No runs match these filters."
            showTarget
            selectedRunId={selectedRunId}
            onSelect={(row) =>
              setParam("run", row.runId === selectedRunId ? null : row.runId!)
            }
          />
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>
              {first}–{last} of {page.total}
            </span>
            <span className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          {selected ? (
            <RunReportView
              cpId={selected.cpId}
              connectorId={selected.connectorId}
              scenarioId={selected.scenarioId}
              runId={selected.runId}
            />
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {selectedRunId
                ? `Run ${selectedRunId} is not on this page.`
                : "Select a run to see its report and transcript."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScenarioRunsPage;
