import React, { useMemo, useState } from "react";
import { formatEnergyKwh } from "@/lib/connectorFormat";
import { cn } from "@/lib/utils";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import { useChargePointView } from "../../../data/hooks/useChargePointView";
import { useDataContext } from "../../../data/providers/DataProvider";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import { useNow } from "../../lib/useNow";
import { usePanelParams } from "../../lib/usePanelParams";
import StatusPill from "../../components/StatusPill";
import NetworkSimBadge from "../../components/network-sim/NetworkSimBadge";
import ActiveScenarioBadge from "../../components/ActiveScenarioBadge";

export interface CpCardProps {
  cp: ChargePointSnapshot;
  /**
   * OCPP version to show in the version chip. Remote-mode snapshots carry
   * their own `config.ocppVersion`; local-mode snapshots don't (the browser
   * owns the config, not the service — see `ChargePointSnapshot.config`'s
   * doc comment), so the caller resolves it from the local config entry
   * instead. Chip is hidden when neither source has a value.
   */
  ocppVersion?: string;
}

const CpCard: React.FC<CpCardProps> = ({ cp, ocppVersion }) => {
  const { open, close, isOpen } = usePanelParams();
  const { chargePointService } = useDataContext();
  const { status, connected, connectors, heartbeat } = useChargePointView(
    cp.id,
  );
  const [isPending, setIsPending] = useState(false);
  // Re-render so "Heartbeat … ago" stays current between heartbeats.
  useNow();

  // Same derivation as the classic UI's ChargePoint.tsx (`isConnected`):
  // after an auto-reconnect the transport can be up before BootNotification
  // is re-Accepted, so fall back to a non-Unavailable status.
  const isConnected = connected || status !== OCPPStatus.Unavailable;
  const resolvedOcppVersion = cp.config?.ocppVersion ?? ocppVersion;
  const connectorList = useMemo(
    () => Array.from(connectors.values()).sort((a, b) => a.id - b.id),
    [connectors],
  );

  const connectorIds = useMemo(
    () => connectorList.map((c) => c.id),
    [connectorList],
  );
  const { runs } = useActiveScenarioRuns(cp.id, connectorIds);

  const firstWaitingExpectation = runs
    .filter((r) => r.state === "waiting" && r.expectation)
    .map(
      (r) =>
        r.expectation?.action ??
        r.expectation?.targetStatus ??
        r.expectation?.type,
    )[0];

  const handleToggleConnect = async () => {
    setIsPending(true);
    try {
      if (isConnected) {
        await chargePointService.disconnect(cp.id);
      } else {
        await chargePointService.connect(cp.id);
      }
    } catch (err) {
      console.error(
        `Failed to ${isConnected ? "disconnect" : "connect"} ${cp.id}`,
        err,
      );
    } finally {
      setIsPending(false);
    }
  };

  const selected = isOpen(cp.id);
  const toggleOpen = () => (selected ? close() : open(cp.id));

  // The whole card opens the panel, except where the click already means
  // something else (a button, link or form control inside it handles itself).
  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("button, a, input, select, label")) return;
    toggleOpen();
  };

  return (
    <div
      data-cp-id={cp.id}
      data-selected={selected ? "true" : undefined}
      onClick={handleCardClick}
      className={cn(
        "flex cursor-pointer flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900",
        selected && "ring-2 ring-blue-500 dark:ring-blue-400",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* A button, so the panel opens from the keyboard too. */}
        <button
          type="button"
          onClick={toggleOpen}
          className="font-mono text-sm font-semibold text-gray-900 hover:underline dark:text-gray-100"
        >
          {cp.id}
        </button>
        <div className="flex items-center gap-2">
          <StatusPill status={isConnected ? status : "Disconnected"} />
          <NetworkSimBadge summary={cp.networkSim} />
          <ActiveScenarioBadge
            isActive={runs.length > 0}
            waitingExpectation={firstWaitingExpectation}
          />
        </div>
      </div>

      {resolvedOcppVersion && (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {resolvedOcppVersion}
        </div>
      )}

      <div className="mt-3 flex-1 space-y-1.5">
        {connectorList.length === 0 ? (
          <div className="text-xs text-gray-400 dark:text-gray-500">
            No connectors
          </div>
        ) : (
          connectorList.map((connector) => (
            <button
              type="button"
              key={connector.id}
              onClick={() => open(cp.id, connector.id)}
              className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 text-left text-xs text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <span className="w-5 shrink-0 text-gray-400 dark:text-gray-500">
                #{connector.id}
              </span>
              <StatusPill status={connector.status} />
              <span>{formatEnergyKwh(connector.meterValue)}</span>
              {connector.transactionId != null && (
                <span className="text-gray-500 dark:text-gray-400">
                  Tx #{connector.transactionId}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Heartbeat {formatRelativeTime(heartbeat.lastSentAt)}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleToggleConnect()}
            disabled={isPending}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium",
              isConnected
                ? "border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950"
                : "border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950",
              isPending && "opacity-50",
            )}
          >
            {isConnected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CpCard;
