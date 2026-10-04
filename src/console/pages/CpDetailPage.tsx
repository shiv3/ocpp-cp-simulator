import React, { useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import SidePanel from "../components/SidePanel";
import CpDetailContent from "./cp/CpDetailContent";
import ScenarioRunContent from "./scenarios/run/ScenarioRunContent";

/**
 * The full charge point page (`/cp/:cpId`). The body lives in
 * `CpDetailContent`, shared with the Charge Points list's side panel; this
 * wrapper keeps the selected connector in the URL (`?connector=`) and, when
 * `?run=<scenarioId>` names a scenario, shows that scenario's run on the
 * selected connector in a side panel beside the page.
 */
const CpDetailPage: React.FC = () => {
  const { cpId = "" } = useParams<{ cpId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("connector");
  const selectedConnectorId =
    raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const runScenarioId = searchParams.get("run") || null;

  const onSelectConnector = useCallback(
    (id: number) => {
      const next = new URLSearchParams(searchParams);
      next.set("connector", String(id));
      // The run panel shows a run on the connector it was opened from.
      if (String(id) !== raw) next.delete("run");
      // Choosing a connector is not a navigation worth a history entry.
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams, raw],
  );

  const closeRun = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("run");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <>
      <CpDetailContent
        cpId={cpId}
        variant="page"
        selectedConnectorId={selectedConnectorId}
        onSelectConnector={onSelectConnector}
      />
      <SidePanel
        open={runScenarioId !== null}
        onClose={closeRun}
        label="Scenario run"
      >
        {runScenarioId !== null && (
          // Keyed so another run starts from a clean state.
          <ScenarioRunContent
            key={`${cpId}\n${selectedConnectorId}\n${runScenarioId}`}
            cpId={cpId}
            connectorId={selectedConnectorId}
            scenarioId={runScenarioId}
            variant="panel"
            onClose={closeRun}
          />
        )}
      </SidePanel>
    </>
  );
};

export default CpDetailPage;
