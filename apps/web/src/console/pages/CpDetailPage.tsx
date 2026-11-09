import { useTranslation } from "react-i18next";
import React, { useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import SidePanel from "../components/SidePanel";
import { withPanelEditing } from "../lib/useScenarioPanelParams";
import { useRunPanelParams } from "../lib/useRunPanelParams";
import CpDetailContent from "./cp/CpDetailContent";
import ScenarioRunContent from "./scenarios/run/ScenarioRunContent";

/**
 * The full charge point page (`/cp/:cpId`). The body lives in
 * `CpDetailContent`, shared with the Charge Points list's side panel; this
 * wrapper keeps the selected connector in the URL (`?connector=`) and, when
 * `?run=<scenarioId>` names a scenario, shows that scenario's run on the
 * selected connector in a side panel beside the page (`&edit=1`: the
 * panel's editor).
 */
const CpDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { cpId = "" } = useParams<{ cpId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("connector");
  const selectedConnectorId =
    raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const {
    scenarioId: runScenarioId,
    editing,
    open: openRun,
    close: closeRun,
    setEditing,
    cancelEditRef,
    handleEscape: handlePanelEscape,
  } = useRunPanelParams();
  // The body reads its snapshot once on mount. On a reload in Local mode the
  // page mounts before the charge point is created, so remount the body when
  // the list first names the charge point (tests render without a registry
  // and keep the immediate content).
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const known = chargePoints.some((cp) => cp.id === cpId);

  const onSelectConnector = useCallback(
    (id: number) => {
      let next = new URLSearchParams(searchParams);
      next.set("connector", String(id));
      // The run panel shows a run on the connector it was opened from.
      if (String(id) !== raw) {
        next.delete("run");
        next = withPanelEditing(next, false);
      }
      // Choosing a connector is not a navigation worth a history entry.
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams, raw],
  );

  return (
    <>
      <CpDetailContent
        key={known ? "listed" : "pending"}
        cpId={cpId}
        variant="page"
        selectedConnectorId={selectedConnectorId}
        onSelectConnector={onSelectConnector}
        onOpenScenario={openRun}
      />
      <SidePanel
        open={runScenarioId !== null}
        onClose={handlePanelEscape}
        label={t("dashboard.detail.scenarioRunLabel")}
        wide
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
            editing={editing}
            onEditingChange={setEditing}
            cancelEditRef={cancelEditRef}
          />
        )}
      </SidePanel>
    </>
  );
};

export default CpDetailPage;
