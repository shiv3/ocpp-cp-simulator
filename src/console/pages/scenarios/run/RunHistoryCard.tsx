import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { mergeRunHistory, runRowKey } from "../../../lib/runHistoryRows";
import { buildRunHistoryUrl } from "../../../lib/useAllScenarios";
import type { ScenarioRunHistoryEntry } from "../../../lib/useScenarioRun";
import { useScenarioRunHistory } from "../../../lib/useScenarioRunHistory";
import RunHistory from "./RunHistory";
import RunReportView from "./RunReportView";

/** How many recorded runs the card lists; the run history page has the rest. */
const RECORDED_RUNS_LIMIT = 20;

export interface RunHistoryCardProps {
  cpId: string;
  connectorId: number | null;
  scenarioId: string;
  /** The runs the page tracked itself (`useScenarioRun().runs`). */
  runs: ScenarioRunHistoryEntry[];
}

/**
 * The run page's **Run history** (#388): the daemon's recorded runs of this
 * target, so the history outlives the page view, merged with the runs the
 * page tracked itself (the live one, and every run in Local mode, which
 * records none). Selecting a run opens its report under the list.
 */
const RunHistoryCard: React.FC<RunHistoryCardProps> = ({
  cpId,
  connectorId,
  scenarioId,
  runs,
}) => {
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
  const target = `${cpId}\n${connectorId ?? ""}\n${scenarioId}`;
  const [selection, setSelection] = useState({
    target,
    runId: null as string | null,
  });
  const selectedRunId = selection.target === target ? selection.runId : null;

  return (
    <div className="rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none">
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
        selectedKey={selectedRunId ? runRowKey(cpId, selectedRunId) : null}
        onSelect={(row) =>
          setSelection({
            target,
            runId: selectedRunId === row.runId ? null : (row.runId ?? null),
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
  );
};

export default RunHistoryCard;
