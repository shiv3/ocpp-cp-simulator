import React, { useEffect, useMemo } from "react";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { useChargePointView } from "../../../data/hooks/useChargePointView";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import type { CpListRow } from "./cpListFilters";

export interface CpRowReporterProps {
  cp: ChargePointSnapshot;
  /** `ocppVersion` for a snapshot without `config` (Local mode). */
  ocppVersionFallback?: string;
  report: (row: CpListRow) => void;
  forget: (id: string) => void;
}

/**
 * Renders nothing: runs the hooks for one charge point and reports its live
 * row to `useCpListRows`.
 */
const CpRowReporter: React.FC<CpRowReporterProps> = ({
  cp,
  ocppVersionFallback,
  report,
  forget,
}) => {
  const { status, connected, error, connectors, heartbeat } =
    useChargePointView(cp.id);

  const connectorList = useMemo(
    () => Array.from(connectors.values()).sort((a, b) => a.id - b.id),
    [connectors],
  );
  const connectorIds = useMemo(
    () => connectorList.map((c) => c.id),
    [connectorList],
  );
  const { runs } = useActiveScenarioRuns(cp.id, connectorIds);

  const row = useMemo<CpListRow>(() => {
    const rowConnectors = connectorList.map((connector) => {
      const own = runs.filter((r) => r.connectorId === connector.id);
      const waiting = own.find((r) => r.state === "waiting" && r.expectation);
      return {
        ...connector,
        hasRun: own.length > 0,
        runState: own[0]?.state,
        runName: own[0]?.name,
        waitingExpectation: waiting
          ? (waiting.expectation?.action ??
            waiting.expectation?.targetStatus ??
            waiting.expectation?.type)
          : undefined,
      };
    });
    return {
      cp: {
        ...cp,
        status,
        error,
        connectors: connectorList,
        heartbeat: {
          intervalSeconds: heartbeat.intervalSeconds,
          lastSentAt: heartbeat.lastSentAt?.toISOString() ?? null,
        },
      },
      // Local-mode snapshots don't carry `config` (the browser owns config,
      // not the service), so the caller passes the shared local config's
      // ocppVersion as the fallback.
      ocppVersion: cp.config?.ocppVersion ?? ocppVersionFallback,
      // Same derivation as the classic UI's `isConnected`: after an
      // auto-reconnect the transport can be up before BootNotification is
      // re-Accepted, so fall back to a non-Unavailable status.
      connected: connected || status !== OCPPStatus.Unavailable,
      connectors: rowConnectors,
    };
  }, [
    cp,
    status,
    error,
    connected,
    connectorList,
    heartbeat,
    runs,
    ocppVersionFallback,
  ]);

  useEffect(() => {
    report(row);
  }, [row, report]);
  useEffect(() => () => forget(cp.id), [cp.id, forget]);

  return null;
};

export default CpRowReporter;
