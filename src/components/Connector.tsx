import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  memo,
} from "react";
import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";

// Dynamic imports for heavy components (bundle-dynamic-imports)
const MeterValueCurveModal = lazy(() => import("./MeterValueCurveModal"));
const ScenarioEditor = lazy(() => import("./scenario/ScenarioEditor"));
const StateTransitionViewer = lazy(
  () => import("./state-transition/StateTransitionViewer"),
);
import { GitBranch } from "lucide-react";
import { saveConnectorAutoMeterConfig } from "../utils/connectorStorage";
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

interface ConnectorDetailsPanelProps {
  cpId: string;
  connectorId: number;
  connectorStatus: ocpp.OCPPStatus;
  transactionId: number | null;
  transactionStartTime: Date | null;
  transactionTagId: string | null;
  liveMeterValue: number;
  meterValue: number;
  setMeterValue: (value: number) => void;
  tagId: string;
  setIdTag: (tagId: string) => void;
  availability: OCPPAvailability;
  autoMeterValueConfig: AutoMeterValueConfig | null;
  autoResetToAvailable: boolean;
  activeScenarioNames: string[];
  onStartTransaction: () => void;
  onStopTransaction: () => void;
  onIncreaseMeterValue: () => void;
  onSendMeterValue: () => void;
  onToggleAutoMeterValue: () => void;
  onOpenConfigModal: () => void;
  onStatusNotification: () => void;
  onToggleAutoResetToAvailable: () => void;
}

const ConnectorDetailsPanel: React.FC<ConnectorDetailsPanelProps> = ({
  connectorStatus,
  transactionId,
  transactionStartTime,
  transactionTagId,
  liveMeterValue,
  meterValue,
  setMeterValue,
  tagId,
  setIdTag,
  availability,
  autoMeterValueConfig,
  autoResetToAvailable,
  activeScenarioNames,
  onStartTransaction,
  onStopTransaction,
  onIncreaseMeterValue,
  onSendMeterValue,
  onToggleAutoMeterValue,
  onOpenConfigModal,
  onStatusNotification,
  onToggleAutoResetToAvailable,
}) => {
  const [duration, setDuration] = useState<string>("00:00:00");
  const [transactionStartLabel, setTransactionStartLabel] =
    useState<string>("");

  useEffect(() => {
    if (connectorStatus !== ocpp.OCPPStatus.Charging || !transactionStartTime) {
      setDuration("00:00:00");
      setTransactionStartLabel("");
      return;
    }

    setTransactionStartLabel(transactionStartTime.toLocaleTimeString());

    const interval = setInterval(() => {
      const elapsed = Date.now() - transactionStartTime.getTime();
      const hours = Math.floor(elapsed / 3600000);
      const minutes = Math.floor((elapsed % 3600000) / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      setDuration(
        `${hours.toString().padStart(2, "0")}:${minutes
          .toString()
          .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [connectorStatus, transactionStartTime]);

  const hasActiveScenario = activeScenarioNames.length > 0;

  const getStatusColor = (status: string) => {
    switch (status) {
      case ocpp.OCPPStatus.Available:
        return "bg-green-500";
      case ocpp.OCPPStatus.Charging:
        return "bg-blue-500";
      case ocpp.OCPPStatus.Preparing:
        return "bg-yellow-500";
      case ocpp.OCPPStatus.Faulted:
        return "bg-red-500";
      case ocpp.OCPPStatus.Unavailable:
        return "bg-gray-500";
      default:
        return "bg-gray-400";
    }
  };

  return (
    <div className="space-y-3">
      {/* Status Dashboard - 3 Column Cards */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold mb-3 text-primary">
          📊 Status Dashboard
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
            <div className="text-xs text-muted mb-1">Status</div>
            <div className="flex items-center justify-center gap-1.5">
              <span
                className={`inline-block w-2 h-2 rounded-full ${getStatusColor(connectorStatus)}`}
              ></span>
              <span className="text-sm font-bold text-primary">
                {connectorStatus}
              </span>
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
            <div className="text-xs text-muted mb-1">Meter</div>
            <div className="text-sm font-bold font-mono text-primary">
              {liveMeterValue.toLocaleString()}
            </div>
            <div className="text-xs text-muted">Wh</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
            <div className="text-xs text-muted mb-1">Availability</div>
            <div className="flex items-center justify-center gap-1.5">
              <span
                className={`inline-block w-2 h-2 rounded-full ${availability === "Operative" ? "bg-green-500" : "bg-red-500"}`}
              ></span>
              <span className="text-sm font-bold text-primary">
                {availability}
              </span>
            </div>
          </div>
        </div>
      </div>

      {connectorStatus === ocpp.OCPPStatus.Charging &&
      transactionId !== null &&
      transactionId !== 0 ? (
        <div className="panel p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/50 dark:to-emerald-950/50 border-l-4 border-green-500">
          <h3 className="text-sm font-semibold mb-3 text-green-700 dark:text-green-300 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            Active Transaction
          </h3>
          <div className="text-2xl font-bold font-mono text-green-800 dark:text-green-200 mb-3">
            #{transactionId}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-green-600 dark:text-green-400">
                ID Tag:
              </span>
              <span className="font-mono font-medium text-green-800 dark:text-green-200">
                {transactionTagId || tagId}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600 dark:text-green-400">
                Started:
              </span>
              <span className="font-mono font-medium text-green-800 dark:text-green-200">
                {transactionStartLabel}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600 dark:text-green-400">
                Duration:
              </span>
              <span className="font-mono font-medium text-green-800 dark:text-green-200">
                {duration}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600 dark:text-green-400">
                Energy:
              </span>
              <span className="font-mono font-medium text-green-800 dark:text-green-200">
                {(liveMeterValue / 1000).toFixed(2)} kWh
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {hasActiveScenario ? (
        <div className="panel p-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/50 dark:to-indigo-950/50 border-l-4 border-blue-500">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-primary flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              Scenario Running
            </span>
            <span className="text-xs text-muted">
              {activeScenarioNames.join(", ")}
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="panel p-3">
          <h4 className="text-xs font-semibold mb-2 text-muted flex items-center gap-1">
            💳 Transaction
          </h4>
          <input
            type="text"
            value={tagId}
            onChange={(e) => setIdTag(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 mb-2"
            placeholder="ID Tag"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onStartTransaction}
              disabled={connectorStatus === ocpp.OCPPStatus.Charging}
              className="btn-success text-xs py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ▶️ Start
            </button>
            <button
              onClick={onStopTransaction}
              disabled={connectorStatus !== ocpp.OCPPStatus.Charging}
              className="btn-warning text-xs py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ⏹️ Stop
            </button>
          </div>
        </div>

        <div className="panel p-3">
          <h4 className="text-xs font-semibold mb-2 text-muted flex items-center gap-1">
            ⚡ Meter Value
          </h4>
          <input
            type="number"
            value={meterValue}
            onChange={(e) => setMeterValue(Number(e.target.value))}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:ring-2 focus:ring-blue-500 mb-2"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onIncreaseMeterValue}
              className="btn-info text-xs py-1.5"
            >
              +10 Wh
            </button>
            <button
              onClick={onSendMeterValue}
              className="btn-secondary text-xs py-1.5"
            >
              📤 Send
            </button>
          </div>
        </div>
      </div>

      <div className="panel p-3">
        <h4 className="text-xs font-semibold mb-2 text-muted">
          📡 Status Control
        </h4>
        <div className="flex gap-2">
          <select
            className="input-base text-xs flex-1 py-1.5"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                onStatusNotification();
                e.target.value = "";
              }
            }}
          >
            <option value="">Change Status...</option>
            <option value={ocpp.OCPPStatus.Available}>Available</option>
            <option value={ocpp.OCPPStatus.Preparing}>Preparing</option>
            <option value={ocpp.OCPPStatus.Charging}>Charging</option>
            <option value={ocpp.OCPPStatus.SuspendedEVSE}>SuspendedEVSE</option>
            <option value={ocpp.OCPPStatus.SuspendedEV}>SuspendedEV</option>
            <option value={ocpp.OCPPStatus.Finishing}>Finishing</option>
            <option value={ocpp.OCPPStatus.Reserved}>Reserved</option>
            <option value={ocpp.OCPPStatus.Unavailable}>Unavailable</option>
            <option value={ocpp.OCPPStatus.Faulted}>Faulted</option>
          </select>
          <button
            onClick={onStatusNotification}
            className="btn-secondary text-xs px-3"
          >
            📤 Send
          </button>
        </div>
      </div>

      <div className="panel p-3">
        <h3 className="text-xs font-semibold mb-3 text-muted">⚙️ Settings</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">
              Auto Available on Stop
            </span>
            <button
              onClick={onToggleAutoResetToAvailable}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                autoResetToAvailable
                  ? "bg-green-500"
                  : "bg-gray-300 dark:bg-gray-600"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  autoResetToAvailable ? "translate-x-5" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {autoMeterValueConfig ? (
            <div className="flex items-center justify-between py-1 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  Auto MeterValue
                </span>
                {autoMeterValueConfig.enabled ? (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                    Active
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={onToggleAutoMeterValue}
                  className={`text-xs px-2 py-1 rounded ${
                    autoMeterValueConfig.enabled
                      ? "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300"
                      : "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300"
                  }`}
                >
                  {autoMeterValueConfig.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={onOpenConfigModal}
                  className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                >
                  ⚙️
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const Connector: React.FC<ConnectorProps> = ({
  id: connector_id,
  cpId,
  idTag,
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
    transactionStartTime,
    transactionTagId,
    transactionBatteryCapacityKwh,
    autoMeterValueConfig,
    autoResetToAvailable,
  } = useConnectorView(cpId, connector_id);
  const { scenarios } = useScenarios(cpId ?? null, connector_id);
  const [meterValueInput, setMeterValueInput] =
    useState<number>(liveMeterValue);
  useEffect(() => {
    setMeterValueInput(liveMeterValue);
  }, [liveMeterValue]);
  const [tagId, setIdTag] = useState<string>(idTag);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isScenarioEditorOpen, setIsScenarioEditorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "connector" | "scenario" | "stateTransition"
  >("connector");
  const [panelWidth, setPanelWidth] = useState(50);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [scenarioExecutionContext, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [nodeProgress, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});
  const [activeScenarioNames, setActiveScenarioNames] = useState<string[]>([]);

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
      const names = activeIds.map(
        (id) => activeManager.getScenario(id)?.name ?? id,
      );
      setActiveScenarioNames(names);
    }, 500);

    return () => {
      clearInterval(intervalId);
      connector.setOnMeterValueSend(() => {});
      manager.destroy();
      scenarioManagerRef.current = null;
    };
  }, [connector_id, localCp]);

  useEffect(() => {
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
  }, [scenarios, localCp, connector_id]);

  // Remote mode: track active scenarios via service events.
  useEffect(() => {
    if (mode !== "remote") return;
    const activeIds = new Map<string, string>(); // scenarioId -> display name

    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if (
        event.type === "scenario-started" &&
        event.connectorId === connector_id
      ) {
        activeIds.set(event.scenarioId, event.scenarioId);
        setActiveScenarioNames([...activeIds.keys()]);
      } else if (
        (event.type === "scenario-completed" ||
          event.type === "scenario-error") &&
        event.connectorId === connector_id
      ) {
        activeIds.delete(event.scenarioId);
        setActiveScenarioNames([...activeIds.keys()]);
      }
    });
    return () => unsubscribe();
  }, [mode, cpId, connector_id, chargePointService]);

  const handleStatusNotification = () => {
    void chargePointService.sendStatusNotification(
      cpId,
      connector_id,
      connectorStatus,
    );
  };

  const handleStartTransaction = () => {
    void chargePointService.startTransaction(cpId, connector_id, tagId);
  };

  const handleStopTransaction = () => {
    void chargePointService.stopTransaction(cpId, connector_id);
  };

  const handleIncreaseMeterValue = () => {
    const nextValue = meterValueInput + 10;
    setMeterValueInput(nextValue);
    void chargePointService.setMeterValue(cpId, connector_id, nextValue);
  };

  const handleSendMeterValue = () => {
    void chargePointService
      .setMeterValue(cpId, connector_id, meterValueInput)
      .then(() => chargePointService.sendMeterValue(cpId, connector_id));
  };

  const handleToggleAutoMeterValue = () => {
    if (!autoMeterValueConfig) return;
    const newConfig = {
      ...autoMeterValueConfig,
      enabled: !autoMeterValueConfig.enabled,
    };
    void chargePointService.setAutoMeterValueConfig(
      cpId,
      connector_id,
      newConfig,
    );
  };

  const handleSaveAutoMeterValueConfig = (config: AutoMeterValueConfig) => {
    void chargePointService.setAutoMeterValueConfig(cpId, connector_id, config);
    if (mode === "local") {
      saveConnectorAutoMeterConfig(cpId, connector_id, config);
    }
  };

  const handleToggleAutoResetToAvailable = () => {
    void chargePointService.setAutoResetToAvailable(
      cpId,
      connector_id,
      !autoResetToAvailable,
    );
  };

  const handleOpenScenarioEditor = () => {
    setIsScenarioEditorOpen(true);
  };

  const handleRemoveConnector = () => {
    if (
      window.confirm(
        `Are you sure you want to remove Connector ${connector_id}?`,
      )
    ) {
      void chargePointService.removeConnector(cpId, connector_id);
    }
  };

  const handleCloseScenarioEditor = useCallback(() => {
    setIsScenarioEditorOpen(false);
  }, []);

  // Resize handlers
  const handleResizeStart = (e: React.MouseEvent) => {
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = panelWidth;
    e.preventDefault();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = resizeStartX.current - e.clientX;
      const viewportWidth = window.innerWidth;
      const deltaVw = (deltaX / viewportWidth) * 100;
      const newWidth = Math.min(
        95,
        Math.max(30, resizeStartWidth.current + deltaVw),
      );
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (!isScenarioEditorOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsScenarioEditorOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isScenarioEditorOpen]);

  // Battery visualization derived from snapshot.
  const batteryCapacityKwh = transactionBatteryCapacityKwh ?? 100;
  const chargingLevel =
    liveSoc !== null
      ? Math.min(100, Math.max(0, liveSoc))
      : Math.min(100, (liveMeterValue / (batteryCapacityKwh * 1000)) * 100);

  const getBatteryColor = () => {
    if (connectorStatus === ocpp.OCPPStatus.Faulted)
      return "text-red-500 dark:text-red-400";
    if (connectorStatus === ocpp.OCPPStatus.Unavailable)
      return "text-gray-400 dark:text-gray-600";
    if (connectorStatus === ocpp.OCPPStatus.Charging)
      return "text-green-500 dark:text-green-400";
    if (connectorStatus === ocpp.OCPPStatus.Available)
      return "text-blue-500 dark:text-blue-400";
    return "text-yellow-500 dark:text-yellow-400";
  };

  const getBatteryFillColor = () => {
    if (connectorStatus === ocpp.OCPPStatus.Faulted)
      return "bg-red-500 dark:bg-red-400";
    if (connectorStatus === ocpp.OCPPStatus.Charging)
      return "bg-green-500 dark:bg-green-400";
    if (chargingLevel > 80) return "bg-green-500 dark:bg-green-400";
    if (chargingLevel > 20) return "bg-yellow-500 dark:bg-yellow-400";
    return "bg-red-500 dark:bg-red-400";
  };

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

        <div className="flex items-center gap-4 mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <div className="relative flex-shrink-0">
            <div className={`text-5xl ${getBatteryColor()}`}>🔋</div>
            {connectorStatus === ocpp.OCPPStatus.Charging ? (
              <div className="absolute -top-1 -right-1 text-xl animate-pulse">
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
                <span>{liveSoc !== null ? "Battery SoC" : "Energy"}</span>
                <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                  {liveSoc !== null
                    ? `${liveSoc.toFixed(1)}%`
                    : `${(liveMeterValue / 1000).toFixed(2)} kWh`}
                </span>
              </div>
              {liveSoc !== null ? (
                <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${getBatteryFillColor()} transition-all duration-300 ease-out`}
                    style={{ width: `${chargingLevel}%` }}
                  ></div>
                </div>
              ) : null}
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">
                  <ConnectorAvailability availability={availability} />
                </span>
                {liveSoc !== null ? (
                  <span className="text-gray-600 dark:text-gray-400">
                    {(liveMeterValue / 1000).toFixed(2)} kWh charged
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
            handleOpenScenarioEditor();
          }}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
        >
          <GitBranch className="h-3 w-3" />
          Scenario Editor
        </button>
      </div>

      {isConfigModalOpen && autoMeterValueConfig ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
              <div className="text-white">Loading...</div>
            </div>
          }
        >
          <MeterValueCurveModal
            isOpen={isConfigModalOpen}
            onClose={() => setIsConfigModalOpen(false)}
            initialConfig={autoMeterValueConfig}
            onSave={handleSaveAutoMeterValueConfig}
          />
        </Suspense>
      ) : null}

      {isScenarioEditorOpen ? (
        <div className="fixed inset-0 z-[9999] flex justify-end pointer-events-none">
          <div className="flex-1 bg-black bg-opacity-20 pointer-events-none" />

          <div
            className="bg-white dark:bg-gray-900 shadow-2xl h-full flex flex-row pointer-events-auto"
            style={{ width: `${panelWidth}vw` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`w-2 bg-gray-300 dark:bg-gray-600 hover:bg-blue-500 dark:hover:bg-blue-400 cursor-col-resize flex-shrink-0 transition-colors ${
                isResizing ? "bg-blue-500 dark:bg-blue-400" : ""
              }`}
              onMouseDown={handleResizeStart}
              style={{ cursor: "col-resize" }}
            >
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-1 h-12 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
              </div>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                <div className="flex items-start">
                  <button
                    onClick={() => setActiveTab("connector")}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                      activeTab === "connector"
                        ? "bg-white dark:bg-gray-800 text-primary dark:text-white border-b-2 border-blue-500"
                        : "bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
                    }`}
                  >
                    🔌 Connector Details
                  </button>
                  <button
                    onClick={() => setActiveTab("scenario")}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                      activeTab === "scenario"
                        ? "bg-white dark:bg-gray-800 text-primary dark:text-white border-b-2 border-blue-500"
                        : "bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
                    }`}
                  >
                    ⚙️ Scenario
                  </button>
                  {mode === "local" && (
                    <button
                      onClick={() => setActiveTab("stateTransition")}
                      className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                        activeTab === "stateTransition"
                          ? "bg-white dark:bg-gray-800 text-primary dark:text-white border-b-2 border-blue-500"
                          : "bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
                      }`}
                    >
                      <GitBranch className="h-4 w-4" /> State Transition
                    </button>
                  )}
                  <button
                    onClick={() => setIsScenarioEditorOpen(false)}
                    className="px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center justify-center"
                    title="Close Panel"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-hidden">
                {activeTab === "connector" ? (
                  <div className="h-full flex flex-col">
                    <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
                      <h2 className="text-lg font-bold text-primary">
                        Connector {connector_id} Details
                      </h2>
                      <p className="text-xs text-muted">{cpId}</p>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      <ConnectorDetailsPanel
                        cpId={cpId}
                        connectorId={connector_id}
                        connectorStatus={connectorStatus}
                        transactionId={transactionId}
                        transactionStartTime={transactionStartTime}
                        transactionTagId={transactionTagId}
                        liveMeterValue={liveMeterValue}
                        meterValue={meterValueInput}
                        setMeterValue={setMeterValueInput}
                        tagId={tagId}
                        setIdTag={setIdTag}
                        availability={availability}
                        autoMeterValueConfig={autoMeterValueConfig}
                        autoResetToAvailable={autoResetToAvailable}
                        activeScenarioNames={activeScenarioNames}
                        onStartTransaction={handleStartTransaction}
                        onStopTransaction={handleStopTransaction}
                        onIncreaseMeterValue={handleIncreaseMeterValue}
                        onSendMeterValue={handleSendMeterValue}
                        onToggleAutoMeterValue={handleToggleAutoMeterValue}
                        onOpenConfigModal={() => setIsConfigModalOpen(true)}
                        onStatusNotification={handleStatusNotification}
                        onToggleAutoResetToAvailable={
                          handleToggleAutoResetToAvailable
                        }
                      />
                    </div>
                  </div>
                ) : activeTab === "scenario" ? (
                  <Suspense
                    fallback={
                      <div className="h-full flex items-center justify-center">
                        <div className="text-muted">
                          Loading Scenario Editor...
                        </div>
                      </div>
                    }
                  >
                    <ScenarioEditor
                      cpId={cpId}
                      connectorId={connector_id}
                      scenario={scenario}
                      scenarioId={scenario?.id}
                      executionContext={scenarioExecutionContext}
                      nodeProgress={nodeProgress}
                      onClose={handleCloseScenarioEditor}
                    />
                  </Suspense>
                ) : mode === "local" && localCp ? (
                  <div className="h-full flex flex-col">
                    <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
                      <h2 className="text-lg font-bold text-primary">
                        State Transition Diagram (OCPP 1.6J)
                      </h2>
                      <p className="text-xs text-muted">
                        Connector {connector_id}
                      </p>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      {localCp.getConnector(connector_id) ? (
                        <Suspense
                          fallback={
                            <div className="h-full flex items-center justify-center">
                              <div className="text-muted">
                                Loading State Diagram...
                              </div>
                            </div>
                          }
                        >
                          <StateTransitionViewer
                            connector={localCp.getConnector(connector_id)!}
                            chargePoint={localCp}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted">
                    State transition diagram is available in local mode only.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Connector;
