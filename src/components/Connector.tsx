import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";

import { GitBranch } from "lucide-react";
import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import { useScenarios } from "../data/hooks/useScenarios";
import { useConnectorView } from "../data/hooks/useConnectorView";
import { useDataContext } from "../data/providers/DataProvider";

interface ConnectorProps {
  id: number;
  cpId: string;
  idTag: string;
  isSelected?: boolean;
  onSelect?: () => void;
  /** Called when the user clicks "Scenario Editor". Parent uses this to open
   *  ConnectorSidePanel pre-pinned to the Scenario tab. */
  onOpenScenario?: () => void;
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
  isSelected = false,
  onSelect,
  onOpenScenario,
}) => {
  const { chargePointService, mode } = useDataContext();
  const localCp: ChargePoint | null =
    mode === "local" && chargePointService.getLocalChargePoint
      ? (chargePointService.getLocalChargePoint(cpId) as ChargePoint | null)
      : null;

  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    transactionBatteryCapacityKwh,
    evSettings,
  } = useConnectorView(cpId, connector_id);
  const { scenarios } = useScenarios(cpId ?? null, connector_id);

  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});

  // Local-only: set up the in-browser ScenarioManager with progress hooks.
  // Remote mode lets the server's scenario manager drive things via events.
  const scenarioManagerRef = useRef<ScenarioManager | null>(null);
  const scenarioRef = useRef<ScenarioDefinition | null>(null);

  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);

  useEffect(() => {
    if (!localCp) return;

    const connector = localCp.getConnector(connector_id);
    if (!connector) return;

    connector.setOnMeterValueSend((connId) => {
      localCp.sendMeterValue(connId);
    });

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: localCp,
      connector,
      hooks: {
        onNodeProgress: (nodeId, remaining, total) => {
          setNodeProgress((prev) => ({
            ...prev,
            [nodeId]: { remaining, total },
          }));
        },
        onStateChange: (context) => {
          const currentScenario = scenarioRef.current;
          if (currentScenario && context.scenarioId === currentScenario.id) {
            setScenarioExecutionContext(context);
          }
        },
      },
    });

    const manager = new ScenarioManager(
      connector,
      localCp,
      callbacks,
      connector.scenarioEvents,
    );
    scenarioManagerRef.current = manager;
    connector.setScenarioManager(manager);

    const intervalId = setInterval(() => {
      const activeManager = scenarioManagerRef.current;
      if (!activeManager) return;
      const activeIds = activeManager.getActiveScenarioIds();
      const currentScenario = scenarioRef.current;
      if (currentScenario && activeIds.includes(currentScenario.id)) {
        const context = activeManager.getScenarioExecutionContext(
          currentScenario.id,
        );
        setScenarioExecutionContext(context);
      } else {
        setScenarioExecutionContext(null);
      }
    }, 500);

    return () => {
      clearInterval(intervalId);
      connector.setOnMeterValueSend(() => {});
      manager.destroy();
      scenarioManagerRef.current = null;
    };
  }, [connector_id, localCp]);

  useEffect(() => {
    // In remote mode the editor is hydrated from the server (see the
    // dedicated effect further down). Skip the localStorage-driven path
    // entirely so it doesn't clobber the remote definition with the
    // localStorage default scenario.
    if (mode !== "local") return;

    if (scenarios.length > 0) {
      setScenario((current) => {
        const match = current
          ? scenarios.find((item) => item.id === current.id)
          : null;
        const next = match ?? scenarios[0];
        scenarioRef.current = next;
        return next;
      });
    } else {
      setScenario(null);
      scenarioRef.current = null;
    }

    const manager = scenarioManagerRef.current;
    if (manager) {
      manager.loadScenarios(scenarios);

      if (localCp) {
        const latestEntry = localCp.stateManager.history.getLatestEntry(
          "connector",
          connector_id,
        );
        if (latestEntry) {
          manager.evaluateStatus(
            latestEntry.fromState as ocpp.OCPPStatus,
            latestEntry.toState as ocpp.OCPPStatus,
          );
        }
      }
    }
  }, [mode, scenarios, localCp, connector_id]);

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
              className="text-xs px-2 py-1 btn-danger rounded"
              title="Remove Connector"
            >
              🗑️
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
                  {(liveMeterValue / 1000).toFixed(2)} kWh
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">
                  <ConnectorAvailability availability={availability} />
                </span>
                {liveSoc !== null ? (
                  <span className="text-gray-600 dark:text-gray-400 font-mono">
                    SoC {liveSoc.toFixed(1)}%
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between py-2 border-t border-gray-200 dark:border-gray-700">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Click to open details panel
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenScenario?.();
          }}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
        >
          <GitBranch className="h-3 w-3" />
          Scenario Editor
        </button>
      </div>
    </div>
  );
};

export default Connector;
