import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { Trash2 } from "lucide-react";
import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioNodeType,
} from "../cp/application/scenario/ScenarioTypes";

import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import { useScenarios } from "../data/hooks/useScenarios";
import { useConnectorView } from "../data/hooks/useConnectorView";
import { useDataContext } from "../data/providers/DataProvider";

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

  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});
  // CP-level status — gate for auto-start. We mirror this in card state so
  // the auto-start effect runs in this always-mounted component (the side
  // panel may not be open). Initially Unavailable; flips to Available when
  // BootNotification is accepted.
  const [cpStatus, setCpStatus] = useState<ocpp.OCPPStatus>(
    ocpp.OCPPStatus.Unavailable,
  );

  // Local-only: set up the in-browser ScenarioManager with progress hooks.
  // Remote mode lets the server's scenario manager drive things via events.
  const scenarioManagerRef = useRef<ScenarioManager | null>(null);
  const scenarioRef = useRef<ScenarioDefinition | null>(null);
  const autoStartTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);

  // Track CP-level status so auto-start can wait for BootNotification.Accepted.
  // The CP starts in Unavailable and flips to Available only after the boot
  // result arrives. Disconnect / reset events drop it back to Unavailable.
  useEffect(() => {
    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if (event.type === "status") {
        setCpStatus(event.status);
      } else if (event.type === "disconnected") {
        setCpStatus(ocpp.OCPPStatus.Unavailable);
      }
    });
    void chargePointService.getChargePoint(cpId).then((snapshot) => {
      if (!snapshot) return;
      setCpStatus(snapshot.status);
    });
    return () => unsubscribe();
  }, [chargePointService, cpId]);

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

  // Auto-start scenarios for THIS connector. Lives in the always-mounted
  // connector card (not the side panel) so:
  //  1. The scenario fires regardless of whether the user has the side
  //     panel open.
  //  2. Every connector's scenario gets auto-started independently — the
  //     side panel only ever covers one connector at a time, so putting
  //     auto-start there meant only the currently-viewed connector ever
  //     auto-fired.
  //  3. Opening / closing the side panel doesn't restart the scenario;
  //     the dedup key lives on the Connector domain and survives mounts.
  //
  // Remote mode opts out — the server drives scenario lifecycles, and we
  // shouldn't fire from the browser there.
  useEffect(() => {
    if (mode !== "local") return;
    if (!localCp || !scenario) return;
    const connector = localCp.getConnector(connector_id);
    if (!connector) return;
    if (scenario.enabled === false) {
      connector.lastAutoStartedScenarioKey = null;
      return;
    }
    // Status-trigger scenarios are driven by status events, not boot.
    const hasStatusTriggerNode = scenario.nodes.some(
      (node) => node.type === ScenarioNodeType.STATUS_TRIGGER,
    );
    if (scenario.trigger?.type !== "manual" || hasStatusTriggerNode) {
      connector.lastAutoStartedScenarioKey = null;
      return;
    }
    if (cpStatus !== ocpp.OCPPStatus.Available) return;

    // Start node may gate auto-start on the connector reaching a specific
    // status before firing (e.g. "Charging"). When absent, default to
    // firing on connect (boot-accepted).
    const startNode = scenario.nodes.find(
      (node) => node.type === ScenarioNodeType.START,
    );
    const startData = startNode?.data as
      | { triggerOn?: "connect" | "status"; targetStatus?: ocpp.OCPPStatus }
      | undefined;
    const triggerOn = startData?.triggerOn ?? "connect";
    if (triggerOn === "status") {
      const target = startData?.targetStatus;
      if (!target) return;
      if (connectorStatus !== target) return;
    }

    // Belt-and-braces: skip if anything is already running on this
    // connector's manager. Catches races where the dedup key gets stale.
    const manager = scenarioManagerRef.current;
    if (manager && manager.getActiveScenarioIds().length > 0) return;

    // Key encodes the trigger config + a structural hash of the scenario.
    // We DON'T include scenario.updatedAt — the editor's auto-save bumps
    // it on every panel mount, which would defeat the dedup.
    const structuralKey = JSON.stringify({
      n: scenario.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        data: n.data,
      })),
      e: scenario.edges.map((e) => ({
        id: e.id,
        s: e.source,
        t: e.target,
      })),
    });
    const autoStartKey = `${scenario.id}:${structuralKey}:${triggerOn}:${startData?.targetStatus ?? ""}`;
    if (connector.lastAutoStartedScenarioKey === autoStartKey) return;

    if (autoStartTimerRef.current) {
      clearTimeout(autoStartTimerRef.current);
    }
    autoStartTimerRef.current = setTimeout(() => {
      const activeManager = scenarioManagerRef.current;
      if (!activeManager) return;
      connector.lastAutoStartedScenarioKey = autoStartKey;
      void activeManager.executeScenario(scenario.id);
    }, 300);

    return () => {
      if (autoStartTimerRef.current) {
        clearTimeout(autoStartTimerRef.current);
      }
    };
  }, [mode, localCp, scenario, cpStatus, connectorStatus, connector_id]);

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
                ? "bg-yellow-500 hover:bg-yellow-600"
                : "bg-green-500 hover:bg-green-600"
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
