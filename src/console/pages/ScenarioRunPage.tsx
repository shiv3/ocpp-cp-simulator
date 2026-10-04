import React from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import RunHistoryCard from "./scenarios/run/RunHistoryCard";
import ScenarioRunContent from "./scenarios/run/ScenarioRunContent";

/**
 * The read-only run page (`/scenarios/run?cp=&connector=&id=[&run=][&view=]`):
 * one scenario run with its Steps or Graph view, and the scenario's run
 * history under it. Reached from a run panel's expand button, a Library row's
 * **Run** link and a connector run row's **Open run** link. It has no message
 * log: the charge point page and the Message log page hold the traffic.
 *
 * The page attaches to a run already live in the runtime (#366) and never
 * starts one by opening; when `run=` names a run that is no longer the live
 * one, a banner says so. **← Back** returns to where the page was opened from
 * (`state.from`), else the Scenarios page.
 */
const ScenarioRunPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const cpId = searchParams.get("cp") ?? "";
  const connectorParam = searchParams.get("connector") ?? "";
  const connectorId = /^\d+$/.test(connectorParam)
    ? Number(connectorParam)
    : null;
  const scenarioId = searchParams.get("id") ?? "";
  const requestedRunId = searchParams.get("run");

  const from = (location.state as { from?: unknown } | null)?.from;
  const backHref = typeof from === "string" && from ? from : "/scenarios";

  return (
    <div className="p-6">
      <Link
        to={backHref}
        className="mb-3 inline-block text-sm text-cx-accent hover:underline"
      >
        ← Back
      </Link>
      {/* Keyed: another target starts from a clean run and selection. */}
      <ScenarioRunContent
        key={`${cpId}\n${connectorParam}\n${scenarioId}`}
        cpId={cpId}
        connectorId={connectorId}
        scenarioId={scenarioId}
        variant="page"
        runId={requestedRunId}
        footer={(run) => (
          <RunHistoryCard
            cpId={cpId}
            connectorId={connectorId}
            scenarioId={scenarioId}
            runs={run.runs}
          />
        )}
      />
    </div>
  );
};

export default ScenarioRunPage;
