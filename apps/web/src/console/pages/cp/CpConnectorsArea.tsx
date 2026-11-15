import React from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import type { ConnectorSnapshot } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import EmptyState from "../../components/EmptyState";
import ConnectorCard from "./ConnectorCard";
import ConnectorTabs from "./ConnectorTabs";
import ScenarioCard from "./ScenarioCard";
import type { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";

type ActiveRuns = ReturnType<typeof useActiveScenarioRuns>;

export interface CpConnectorsAreaProps {
  cpId: string;
  isPanel: boolean;
  connectorList: ConnectorSnapshot[];
  connectorIds: number[];
  activeConnectorId: number | null;
  onSelectConnector: (id: number) => void;
  onOpenScenario?: (
    connectorId: number,
    scenarioId: string,
    edit?: boolean,
  ) => void;
  connectorPanelId: string;
  connectorGridRef: React.RefObject<HTMLDivElement | null>;
  runsOn: (connectorId: number) => ActiveRuns["runs"];
  refreshRuns: ActiveRuns["refresh"];
  scheduleRunsRefresh: ActiveRuns["scheduleRefresh"];
}

/** The connector cards of the charge point page (tabs in the panel, one
 *  scrolling row on the full page). */
export const CpConnectorsArea: React.FC<CpConnectorsAreaProps> = ({
  cpId,
  isPanel,
  connectorList,
  connectorIds,
  activeConnectorId,
  onSelectConnector,
  onOpenScenario,
  connectorPanelId,
  connectorGridRef,
  runsOn,
  refreshRuns,
  scheduleRunsRefresh,
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <>
      {connectorList.length === 0 ? (
        <EmptyState
          title={t("cp.page.noConnectors")}
          hint={t("cp.page.noConnectorsHint")}
        />
      ) : (
        <>
          {isPanel ? (
            <>
              <ConnectorTabs
                connectors={connectorList.map((c) => ({
                  id: c.id,
                  status: c.status,
                }))}
                selectedId={activeConnectorId}
                onSelect={onSelectConnector}
                panelId={connectorPanelId}
              />
              {activeConnectorId != null && (
                <div
                  role="tabpanel"
                  id={connectorPanelId}
                  aria-label={t("cp.connector.title", {
                    id: activeConnectorId,
                  })}
                  className="mt-3"
                >
                  <ConnectorCard
                    key={activeConnectorId}
                    cpId={cpId}
                    connectorId={activeConnectorId}
                  />
                  <ScenarioCard
                    cpId={cpId}
                    connectorId={activeConnectorId}
                    connectorIds={connectorIds}
                    runs={runsOn(activeConnectorId)}
                    refresh={refreshRuns}
                    scheduleRefresh={scheduleRunsRefresh}
                    // From the list's panel the link goes to the full page,
                    // whose Back returns to the list.
                    runLinkState={{ from: "/" }}
                    onOpenScenario={
                      onOpenScenario &&
                      ((id, edit) =>
                        onOpenScenario(activeConnectorId, id, edit))
                    }
                  />
                </div>
              )}
            </>
          ) : (
            // The full page shows every connector at once, in ONE row that
            // scrolls horizontally instead of wrapping: `grid-auto-flow:
            // column`, every column at least a quarter of the row
            // (`(100% - 3rem) / 4`, 3rem = the three gutters) and at least
            // 400 px, so at most four are visible; `min(100%, …)` keeps a phone
            // at one card per view and the `1fr` max lets fewer than four share
            // the width. More than four overflow into `overflow-x-auto`, and
            // snapping lands a scroll on a card edge without forcing it. The
            // row is a focusable region so the arrow keys scroll it, and
            // `relative` makes it the containing block of the cards' absolutely
            // positioned bits (the switches' `sr-only` inputs), so the scroll
            // area clips them instead of widening the page. The card lays
            // itself out by its own width.
            <div ref={connectorGridRef} className="@container">
              <div
                data-testid="connector-grid"
                role="region"
                aria-label={t("cp.connectors.label")}
                tabIndex={0}
                className="relative grid snap-x snap-proximity items-start gap-4 overflow-x-auto overscroll-x-contain pb-2 [grid-auto-flow:column]"
                style={{
                  gridAutoColumns:
                    "minmax(min(100%, max(400px, calc((100% - 3rem) / 4))), 1fr)",
                }}
              >
                {connectorList.map((connector) => (
                  <div key={connector.id} className="min-w-0 snap-start">
                    <ConnectorCard
                      cpId={cpId}
                      connectorId={connector.id}
                      selected={connector.id === activeConnectorId}
                      onSelect={() => onSelectConnector(connector.id)}
                    />
                    <ScenarioCard
                      cpId={cpId}
                      connectorId={connector.id}
                      connectorIds={connectorIds}
                      runs={runsOn(connector.id)}
                      refresh={refreshRuns}
                      scheduleRefresh={scheduleRunsRefresh}
                      // On the full page the link only adds `?run=`, so the
                      // page keeps the Back it already had.
                      runLinkState={location.state}
                      onOpenScenario={
                        onOpenScenario &&
                        ((id, edit) => onOpenScenario(connector.id, id, edit))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
};
