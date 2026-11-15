import React, { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import EmptyState from "../../components/EmptyState";
import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import ExpertCallPanel from "./ExpertCallPanel";
import TransactionsTab from "./TransactionsTab";
import ConfigurationKeysTab from "./ConfigurationKeysTab";
import type { Section } from "./cpDetailHelpers";

const StateTransitionViewer = lazy(
  () => import("@/components/state-transition/StateTransitionViewer"),
);
const SessionAnalysisPanel = lazy(() => import("./SessionAnalysisPanel"));
const OperationalTimelinePanel = lazy(
  () => import("./OperationalTimelinePanel"),
);

export interface CpDetailSectionsProps {
  section: Section;
  cpId: string;
  resolvedOcppVersion: string | undefined;
  isConnected: boolean;
  connectorList: ReadonlyArray<{ id: number }>;
  activeConnectorId: number | null;
  onSelectConnector: (id: number) => void;
  localCp: ChargePoint | null;
  diagnosticsConnector: ReturnType<ChargePoint["getConnector"]> | undefined;
}

/** The lower half's tabs other than the log and the network simulation. */
export const CpDetailSections: React.FC<CpDetailSectionsProps> = ({
  section,
  cpId,
  resolvedOcppVersion,
  isConnected,
  connectorList,
  activeConnectorId,
  onSelectConnector,
  localCp,
  diagnosticsConnector,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {section === "transactions" && (
        <section>
          <TransactionsTab cpId={cpId} />
        </section>
      )}

      {section === "events" && (
        <section>
          <Suspense
            fallback={
              <div className="p-6 text-sm text-cx-muted">
                {t("cp.page.loadingEvents")}
              </div>
            }
          >
            <OperationalTimelinePanel key={cpId} cpId={cpId} />
          </Suspense>
        </section>
      )}

      {section === "analysis" && (
        <section>
          <Suspense
            fallback={
              <div className="p-6 text-sm text-cx-muted">
                {t("cp.page.loadingAnalysis")}
              </div>
            }
          >
            <SessionAnalysisPanel
              cpId={cpId}
              ocppVersion={resolvedOcppVersion}
            />
          </Suspense>
        </section>
      )}

      {section === "diagnostics" && (
        <section>
          {connectorList.length > 1 && (
            <select
              data-testid="diagnostics-connector"
              aria-label={t("cp.page.connectorSingular")}
              value={activeConnectorId ?? ""}
              onChange={(e) => onSelectConnector(Number(e.target.value))}
              className={cn(FILTER_SELECT_CLASS, "mb-3")}
            >
              {connectorList.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {t("cp.connector.title", { id: connector.id })}
                </option>
              ))}
            </select>
          )}
          {diagnosticsConnector && localCp ? (
            <div className="h-[520px]">
              <Suspense
                fallback={
                  <div className="p-6 text-sm text-cx-muted">
                    {t("cp.page.loadingDiagram")}
                  </div>
                }
              >
                <StateTransitionViewer
                  connector={diagnosticsConnector}
                  chargePoint={localCp}
                />
              </Suspense>
            </div>
          ) : (
            <EmptyState
              title={t("cp.page.diagramUnavailable")}
              hint={t("cp.page.diagramUnavailableHint")}
            />
          )}
        </section>
      )}

      {section === "configuration" && (
        <section>
          <ConfigurationKeysTab cpId={cpId} />
        </section>
      )}

      {section === "expert" && (
        <section>
          <ExpertCallPanel
            cpId={cpId}
            ocppVersion={resolvedOcppVersion}
            connected={isConnected}
          />
        </section>
      )}
    </>
  );
};
