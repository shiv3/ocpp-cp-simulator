import React, { useEffect, useMemo } from "react";
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
import { runRowKey, summaryToRow } from "../../../lib/runHistoryRows";
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
 * Filters, the page and the selected run live in the URL (`?cp=&connector=
 * &scenario=&verdict=&state=&offset=&run=&runCp=`), so a view can be linked; a
 * linked run no longer on that page is looked up by id. A run is its charge
 * point plus its runId, which is unique per charge point only. The run page's "View
 * all runs" link opens it filtered on that scenario. Local mode records no
 * runs.
 */
const ScenarioRunsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { config, isLoading: configLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, {
    isLoading: configLoading,
  });
  const filters = queryFromParams(searchParams);
  const offsetParam = Number(searchParams.get("offset"));
  const offset =
    Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  const { page, isLoading, error, supported, refresh } = useScenarioRunHistory(
    { ...filters, limit: PAGE_SIZE, offset },
    // Only the filtered charge point can record a run this list shows.
    filters.cpId ? [filters.cpId] : chargePoints.map((cp) => cp.id),
  );
  const rows = useMemo(() => page.runs.map(summaryToRow), [page.runs]);
  // A run is identified by its charge point and runId (`run` + `runCp`): a
  // runId is unique per charge point only. A link without `runCp` opens its
  // run only when the id names a single one across the whole history.
  const selectedRunId = searchParams.get("run");
  const selectedCpId = searchParams.get("runCp");
  const isSelected = (r: { runId: string; cpId: string }) =>
    r.runId === selectedRunId && (!selectedCpId || r.cpId === selectedCpId);
  const onPage = page.runs.find(isSelected) ?? null;
  // Looked up by id when the named run is not on this page (the history
  // moved since the link was copied, or it never was), and always for a link
  // without `runCp`: a match on this page does not rule out one on another
  // page. Asking for two tells an ambiguous id from a unique one.
  const lookup = useScenarioRunHistory(
    selectedRunId && !isLoading && (!selectedCpId || !onPage)
      ? {
          runId: selectedRunId,
          cpId: selectedCpId ?? undefined,
          limit: 2,
        }
      : null,
    [],
  );
  // Filtered again: the lookup keeps its previous answer while it re-asks.
  const lookedUp = lookup.page.runs.filter(isSelected);
  const selected = selectedCpId
    ? (onPage ?? lookedUp[0] ?? null)
    : lookedUp.length === 1
      ? lookedUp[0]
      : null;
  const ambiguous = !selectedCpId && lookedUp.length > 1;

  // The history shrank under the current page (retention, `cp.delete`,
  // `state.reset`): step back to its last page instead of showing an empty one.
  const lastPageOffset =
    page.total === 0 ? 0 : Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const setParams = (
    changes: Record<string, string | null>,
    { replace }: { replace: boolean },
  ) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace });
  };
  // Editing a filter replaces the history entry — typing a scenario id must
  // not leave one Back step per keystroke — and goes back to the first page.
  const setFilter = (key: string, value: string) =>
    setParams(
      { [key]: value, offset: null, run: null, runCp: null },
      { replace: true },
    );
  // Paging and selecting a run are navigation.
  const setOffset = (next: number) =>
    setParams({ offset: next > 0 ? String(next) : null }, { replace: false });
  const selectRun = (run: { runId: string; cpId: string } | null) =>
    setParams(
      { run: run?.runId ?? null, runCp: run?.cpId ?? null },
      { replace: false },
    );

  useEffect(() => {
    if (!isLoading && offset > lastPageOffset) {
      setParams(
        { offset: lastPageOffset > 0 ? String(lastPageOffset) : null },
        { replace: true },
      );
    }
    // setParams is rebuilt each render; the offsets are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, offset, lastPageOffset]);

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
          onChange={(e) => setFilter("cp", e.target.value)}
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
          onChange={(e) => setFilter("connector", e.target.value)}
          placeholder="Connector"
          aria-label="Filter by connector"
          className={`${FILTER_INPUT_CLASS} w-28`}
        />
        <input
          type="text"
          value={filters.scenarioId ?? ""}
          onChange={(e) => setFilter("scenario", e.target.value)}
          placeholder="Scenario id"
          aria-label="Filter by scenario id"
          className={FILTER_INPUT_CLASS}
        />
        <select
          value={filters.verdict ?? ""}
          onChange={(e) => setFilter("verdict", e.target.value)}
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
          onChange={(e) => setFilter("state", e.target.value)}
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
        <p className="mb-4 text-sm text-cx-rose">
          Could not load the run history: {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4">
          <RunHistory
            rows={rows}
            emptyText="No runs match these filters."
            showTarget
            selectedKey={
              selected ? runRowKey(selected.cpId, selected.runId) : null
            }
            onSelect={(row) =>
              selectRun(
                selected && row.key === runRowKey(selected.cpId, selected.runId)
                  ? null
                  : row.summary!,
              )
            }
          />
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-cx-muted">
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

        <div className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-4">
          {selected ? (
            <RunReportView
              cpId={selected.cpId}
              connectorId={selected.connectorId}
              scenarioId={selected.scenarioId}
              runId={selected.runId}
            />
          ) : (
            <p className="text-sm text-cx-muted">
              {selectedRunId
                ? isLoading || lookup.isLoading
                  ? "Loading…"
                  : ambiguous
                    ? `Run ${selectedRunId} was recorded on several charge points — select it in the list.`
                    : `Run ${selectedRunId} is no longer recorded.`
                : "Select a run to see its report and transcript."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScenarioRunsPage;
