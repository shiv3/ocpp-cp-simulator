import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import { useChargePointView } from "../../../data/hooks/useChargePointView";
import { useDataContext } from "../../../data/providers/DataProvider";
import StatusPill from "../../components/StatusPill";
import { consolePath } from "../../routes";

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

function formatRelativeTime(date: Date | null): string {
  if (!date) return "never";
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

const CpCard: React.FC<CpCardProps> = ({ cp, ocppVersion }) => {
  const navigate = useNavigate();
  const { chargePointService } = useDataContext();
  const { status, connected, connectors, heartbeat } = useChargePointView(
    cp.id,
  );
  const [isPending, setIsPending] = useState(false);

  // Same derivation as the classic UI's ChargePoint.tsx (`isConnected`):
  // after an auto-reconnect the transport can be up before BootNotification
  // is re-Accepted, so fall back to a non-Unavailable status.
  const isConnected = connected || status !== OCPPStatus.Unavailable;
  const resolvedOcppVersion = cp.config?.ocppVersion ?? ocppVersion;
  const connectorList = Array.from(connectors.values()).sort(
    (a, b) => a.id - b.id,
  );

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

  return (
    <div
      data-cp-id={cp.id}
      className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={consolePath(`/cp/${encodeURIComponent(cp.id)}`)}
          className="font-mono text-sm font-semibold text-gray-900 hover:underline dark:text-gray-100"
        >
          {cp.id}
        </Link>
        <StatusPill status={isConnected ? status : "Disconnected"} />
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
            <div
              key={connector.id}
              className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
            >
              <span className="w-5 shrink-0 text-gray-400 dark:text-gray-500">
                #{connector.id}
              </span>
              <StatusPill status={connector.status} />
              <span>{connector.meterValue} kWh</span>
              {connector.transactionId != null && (
                <span className="text-gray-500 dark:text-gray-400">
                  Tx #{connector.transactionId}
                </span>
              )}
            </div>
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
            onClick={() =>
              navigate(consolePath(`/cp/${encodeURIComponent(cp.id)}`))
            }
            className="rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Open
          </button>
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
