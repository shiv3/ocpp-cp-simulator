import React, { useState, useEffect, useCallback, memo } from "react";
import { Trash2 } from "lucide-react";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import { useConnectorView } from "../data/hooks/useConnectorView";
import { useDataContext } from "../data/providers/DataProvider";
import { formatEnergyKwh, formatSoc } from "../lib/connectorFormat";

interface ConnectorProps {
  id: number;
  cpId: string;
  idTag: string;
  /** All tag IDs configured on this CP. Drives the per-card TagID picker. */
  tagIds?: string[];
  isSelected?: boolean;
  onSelect?: () => void;
}

// Helper Components (rerender-memo)
const ConnectorStatus = memo<{ status: string }>(({ status }) => {
  const statusColor = (s: string) => {
    switch (s) {
      case ocpp.OCPPStatus.Unavailable:
        return "status-unavailable";
      case ocpp.OCPPStatus.Available:
        return "status-available";
      case ocpp.OCPPStatus.Preparing:
        return "status-preparing";
      case ocpp.OCPPStatus.Charging:
        return "status-charging";
      case ocpp.OCPPStatus.Faulted:
        return "status-error";
      default:
        return "text-secondary";
    }
  };

  return <span className={statusColor(status)}>{status}</span>;
});
ConnectorStatus.displayName = "ConnectorStatus";

const ConnectorAvailability = memo<{ availability: OCPPAvailability }>(
  ({ availability }) => {
    const availabilityColor = (a: OCPPAvailability) => {
      switch (a) {
        case "Operative":
          return "status-available";
        case "Inoperative":
          return "status-unavailable";
        default:
          return "text-secondary";
      }
    };

    return (
      <span className={availabilityColor(availability)}>{availability}</span>
    );
  },
);
ConnectorAvailability.displayName = "ConnectorAvailability";

const Connector: React.FC<ConnectorProps> = ({
  id: connector_id,
  cpId,
  idTag,
  tagIds,
  isSelected = false,
  onSelect,
}) => {
  const { chargePointService } = useDataContext();

  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    transactionBatteryCapacityKwh,
    evSettings,
  } = useConnectorView(cpId, connector_id);

  // Note: this used to auto-seed a "default" scenario for each connector
  // (createDefaultScenario), but that re-spawned the same scenario after
  // every Reset and made "wipe all simulator data" feel like a no-op.
  // The canonical demo flow now lives as the "Essential CP Behavior"
  // template in scenarioTemplates — operators reach for it from the
  // template picker when they want it, and a fresh connector starts with
  // a genuinely empty canvas.

  // Per-card TagID picker. Defaults to the CP-level idTag (which is the
  // first configured tag from ChargePointConfig.tagIds). When the parent
  // supplies a tagIds[] array, the card renders a select so the operator
  // can switch between configured profiles before pressing Start.
  const availableTagIds =
    tagIds && tagIds.length > 0 ? tagIds : idTag ? [idTag] : [];
  const [selectedTagId, setSelectedTagId] = useState<string>(
    availableTagIds[0] ?? idTag ?? "",
  );
  // Keep the selection valid when the parent's tag list changes (CP config
  // edited). Prefer to keep the user's pick if it's still in the new list.
  useEffect(() => {
    if (availableTagIds.length === 0) return;
    if (!availableTagIds.includes(selectedTagId)) {
      setSelectedTagId(availableTagIds[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTagIds.join("|")]);

  // One toggle button drives both directions. Reading `isCharging` from
  // the live status keeps the label/style in sync if the transaction is
  // started/stopped elsewhere (side panel, scenario, remote start).
  const handleTransactionToggle = useCallback(
    (e: React.MouseEvent, isChargingNow: boolean) => {
      e.stopPropagation();
      if (isChargingNow) {
        void chargePointService.stopTransaction(cpId, connector_id);
      } else if (selectedTagId) {
        void chargePointService.startTransaction(
          cpId,
          connector_id,
          selectedTagId,
        );
      }
    },
    [chargePointService, cpId, connector_id, selectedTagId],
  );

  // Scenarios (loading, status triggers, auto-start) and the auto
  // meter-value wiring run in the data layer — LocalScenarioRuntime in Local
  // mode, the daemon in Remote mode — whether or not this card is mounted.

  const handleRemoveConnector = () => {
    if (
      window.confirm(
        `Are you sure you want to remove Connector ${connector_id}?`,
      )
    ) {
      void chargePointService.removeConnector(cpId, connector_id);
    }
  };

  // Battery visualization derived from snapshot.
  const batteryCapacityKwh = transactionBatteryCapacityKwh ?? 100;
  const chargingLevel =
    liveSoc !== null
      ? Math.min(100, Math.max(0, liveSoc))
      : Math.min(100, (liveMeterValue / (batteryCapacityKwh * 1000)) * 100);
  const isCharging = connectorStatus === ocpp.OCPPStatus.Charging;
  const isFaulted = connectorStatus === ocpp.OCPPStatus.Faulted;
  const isUnavailable = connectorStatus === ocpp.OCPPStatus.Unavailable;

  // Bar fill gradient — same palette as the side panel Battery card so the
  // list view and detail view read consistently.
  const barFillClass = isFaulted
    ? "bg-gradient-to-t from-red-500 to-rose-400"
    : isUnavailable
      ? "bg-gradient-to-t from-gray-400 to-gray-300 dark:from-gray-600 dark:to-gray-500"
      : isCharging
        ? "bg-gradient-to-t from-green-500 to-emerald-400"
        : "bg-gradient-to-t from-blue-500 to-sky-400";

  const handleCardClick = useCallback(() => {
    if (onSelect) {
      onSelect();
    }
  }, [onSelect]);

  return (
    <div
      className={`panel cursor-pointer hover:shadow-lg transition-all ${
        isSelected ? "ring-2 ring-blue-500 shadow-lg" : ""
      }`}
      onClick={handleCardClick}
    >
      <div className="mb-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-primary">
            Connector {connector_id}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveConnector();
              }}
              className="inline-flex items-center justify-center text-xs px-2 py-1 btn-danger rounded"
              title="Remove Connector"
              aria-label="Remove Connector"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex items-stretch gap-4 mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          {/* Vertical battery bar — same component family as the side
              panel Battery card. Fill is the SoC % (or meter-derived %
              when SoC is unreported), target-SoC marker shows as a
              dashed amber line. */}
          <div className="relative w-14 flex-shrink-0 rounded-md bg-gray-200 dark:bg-gray-700 overflow-hidden border border-gray-300 dark:border-gray-600">
            <div
              className={`absolute left-0 right-0 bottom-0 transition-[height] duration-300 ease-out ${barFillClass}`}
              style={{ height: `${chargingLevel}%` }}
              aria-hidden
            />
            <div
              className="absolute left-0 right-0 border-t-2 border-dashed border-amber-500"
              style={{ bottom: `${evSettings.targetSoc}%` }}
              title={`Target ${evSettings.targetSoc}%`}
              aria-hidden
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-bold font-mono text-gray-900 dark:text-white drop-shadow-[0_1px_1px_rgba(255,255,255,0.6)] dark:drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
                {liveSoc !== null ? `${Math.round(liveSoc)}%` : "—"}
              </span>
            </div>
            {isCharging ? (
              <div className="absolute top-0.5 right-0.5 text-xs animate-pulse">
                ⚡
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold text-primary">
                <ConnectorStatus status={connectorStatus} />
              </span>
              {transactionId != null && transactionId !== 0 ? (
                <span className="text-xs text-muted font-mono">
                  TX:{transactionId}
                </span>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                <span>Energy</span>
                <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                  {formatEnergyKwh(liveMeterValue)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">
                  <ConnectorAvailability availability={availability} />
                </span>
                {liveSoc !== null ? (
                  <span className="text-gray-600 dark:text-gray-400 font-mono">
                    SoC {formatSoc(liveSoc)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Transaction controls — TagID is always a select sourced from the
            CP profile's `tagIds`, and one toggle button covers Start/Stop
            (label flips based on isCharging). stopPropagation keeps card
            clicks from also fighting the controls. */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
          <div className="flex items-center gap-2">
            <label
              htmlFor={`connector-tag-${cpId}-${connector_id}`}
              className="text-xs text-muted whitespace-nowrap"
            >
              TagID
            </label>
            <select
              id={`connector-tag-${cpId}-${connector_id}`}
              value={
                availableTagIds.includes(selectedTagId)
                  ? selectedTagId
                  : (availableTagIds[0] ?? "")
              }
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                setSelectedTagId(e.target.value);
              }}
              disabled={isCharging || availableTagIds.length === 0}
              className="flex-1 min-w-0 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono disabled:opacity-60"
              title="Switch RFID tag profile before starting a transaction"
            >
              {availableTagIds.length === 0 ? (
                <option value="">No TagIDs configured</option>
              ) : (
                availableTagIds.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))
              )}
            </select>
          </div>
          <button
            type="button"
            onClick={(e) => handleTransactionToggle(e, isCharging)}
            disabled={!isCharging && !selectedTagId}
            className={`w-full text-sm py-1.5 px-3 font-medium text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              isCharging
                ? "bg-amber-700 hover:bg-amber-800"
                : "bg-green-700 hover:bg-green-800"
            }`}
          >
            {isCharging ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Connector;
