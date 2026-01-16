import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  memo,
} from "react";
import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
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

interface ConnectorProps {
  id: number;
  cp: ChargePoint | null;
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
  cp: ChargePoint;
  connectorId: number;
  connectorStatus: ocpp.OCPPStatus;
  transactionId: number | null;
  meterValue: number;
  setMeterValue: (value: number) => void;
  tagId: string;
  setIdTag: (tagId: string) => void;
  availability: OCPPAvailability;
  autoMeterValueConfig: AutoMeterValueConfig | null;
  autoResetToAvailable: boolean;
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
  cp,
  connectorId,
  connectorStatus,
  transactionId,
  meterValue,
  setMeterValue,
  tagId,
  setIdTag,
  availability,
  autoMeterValueConfig,
  autoResetToAvailable,
  onStartTransaction,
  onStopTransaction,
  onIncreaseMeterValue,
  onSendMeterValue,
  onToggleAutoMeterValue,
  onOpenConfigModal,
  onStatusNotification,
  onToggleAutoResetToAvailable,
}) => {
  const connector = cp.getConnector(connectorId);
  const scenarioManager = connector?.scenarioManager;

  // Get scenario status with reactive polling
  const [activeScenarioIds, setActiveScenarioIds] = useState<string[]>([]);
  const [duration, setDuration] = useState<string>("00:00:00");
  const [transactionStartTime, setTransactionStartTime] = useState<string>("");

  useEffect(() => {
    // Poll active scenarios every 500ms to keep UI reactive
    const interval = setInterval(() => {
      const ids = scenarioManager?.getActiveScenarioIds() || [];
      setActiveScenarioIds(ids);
    }, 500);

    // Initial load
    const ids = scenarioManager?.getActiveScenarioIds() || [];
    setActiveScenarioIds(ids);

    return () => clearInterval(interval);
  }, [scenarioManager]);

  // Track transaction duration
  useEffect(() => {
    if (
      connectorStatus !== ocpp.OCPPStatus.Charging ||
      !connector?.transaction
    ) {
      setDuration("00:00:00");
      setTransactionStartTime("");
      return;
    }

    const startTime = connector.transaction.startTime;
    if (startTime) {
      setTransactionStartTime(startTime.toLocaleTimeString());
    }

    const interval = setInterval(() => {
      const currentConnector = cp.getConnector(connectorId);
      const txStartTime = currentConnector?.transaction?.startTime;
      if (txStartTime) {
        const elapsed = Date.now() - txStartTime.getTime();
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        setDuration(
          `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
        );
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [connectorStatus, connector?.transaction, cp, connectorId]);

  const hasActiveScenario = activeScenarioIds.length > 0;

  // Helper function to get status color
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
          {/* Status Card */}
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
          {/* Meter Card */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
            <div className="text-xs text-muted mb-1">Meter</div>
            <div className="text-sm font-bold font-mono text-primary">
              {meterValue.toLocaleString()}
            </div>
            <div className="text-xs text-muted">Wh</div>
          </div>
          {/* Availability Card */}
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

      {/* Active Transaction Panel - Only shown when charging (rendering-conditional-render) */}
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
                {connector?.transaction?.tagId || tagId}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600 dark:text-green-400">
                Started:
              </span>
              <span className="font-mono font-medium text-green-800 dark:text-green-200">
                {transactionStartTime}
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
                {(meterValue / 1000).toFixed(2)} kWh
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Scenario Status - Compact (rendering-conditional-render) */}
      {hasActiveScenario ? (
        <div className="panel p-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/50 dark:to-indigo-950/50 border-l-4 border-blue-500">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-primary flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              Scenario Running
            </span>
            <span className="text-xs text-muted">
              {activeScenarioIds
                .map((id) => scenarioManager?.getScenario(id)?.name || id)
                .join(", ")}
            </span>
          </div>
        </div>
      ) : null}

      {/* Controls Section - 2 Column Layout */}
      <div className="grid grid-cols-2 gap-3">
        {/* Transaction Control Card */}
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

        {/* Meter Control Card */}
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

      {/* Status Control */}
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
                cp.updateConnectorStatus(
                  connectorId,
                  e.target.value as ocpp.OCPPStatus,
                );
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

      {/* Settings Section */}
      <div className="panel p-3">
        <h3 className="text-xs font-semibold mb-3 text-muted">⚙️ Settings</h3>
        <div className="space-y-2">
          {/* Auto Reset Toggle */}
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

          {/* Auto Meter Value Config (rendering-conditional-render) */}
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
  cp,
  idTag,
  isSelected = false,
  onSelect,
}) => {
  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    autoMeterValueConfig,
    autoResetToAvailable,
  } = useConnectorView(cp, connector_id);
  const { scenarios } = useScenarios(cp?.id ?? null, connector_id);
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
  const [panelWidth, setPanelWidth] = useState(50); // Default 50vw
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Scenario state (single scenario per connector)
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [scenarioExecutionContext, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [nodeProgress, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});

  useEffect(() => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    connector.setOnMeterValueSend((connId) => {
      cp.sendMeterValue(connId);
    });

    return () => {
      connector.setOnMeterValueSend(() => {});
    };
  }, [connector_id, cp]);

  const scenarioManagerRef = useRef<ScenarioManager | null>(null);
  const scenarioRef = useRef<ScenarioDefinition | null>(null);

  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);

  useEffect(() => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: {
        onNodeProgress: (nodeId, remaining, total) => {
          setNodeProgress((prev) => ({
            ...prev,
            [nodeId]: { remaining, total },
          }));
        },
        onStateChange: (context) => {
          // Update execution context when scenario state changes
          const currentScenario = scenarioRef.current;
          if (currentScenario && context.scenarioId === currentScenario.id) {
            setScenarioExecutionContext(context);
          }
        },
      },
    });

    const manager = new ScenarioManager(
      connector,
      cp,
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
      manager.destroy();
      scenarioManagerRef.current = null;
    };
  }, [connector_id, cp]);

  useEffect(() => {
    if (scenarios.length > 0) {
      console.debug("[Connector] Loaded scenarios", scenarios);
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
      console.debug(
        "[Connector] Refreshing ScenarioManager with scenarios",
        scenarios,
      );
      manager.loadScenarios(scenarios);

      if (cp) {
        const latestEntry = cp.stateManager.history.getLatestEntry(
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
  }, [scenarios, cp, connector_id]);

  // Implement connector logic here...
  const handleStatusNotification = () => {
    if (cp) {
      cp.updateConnectorStatus(connector_id, connectorStatus);
    }
  };

  const handleStartTransaction = () => {
    if (cp) {
      cp.startTransaction(tagId, connector_id);
    }
  };

  const handleStopTransaction = () => {
    if (cp) {
      cp.stopTransaction(connector_id);
    }
  };

  const handleIncreaseMeterValue = () => {
    if (cp) {
      const nextValue = meterValueInput + 10;
      setMeterValueInput(nextValue);
      cp.setMeterValue(connector_id, nextValue);
    }
  };

  const handleSendMeterValue = () => {
    if (cp) {
      cp.setMeterValue(connector_id, meterValueInput);
      cp.sendMeterValue(connector_id);
    }
  };

  const handleToggleAutoMeterValue = () => {
    if (!cp || !autoMeterValueConfig) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    const newConfig = {
      ...autoMeterValueConfig,
      enabled: !autoMeterValueConfig.enabled,
    };

    connector.autoMeterValueConfig = newConfig;
  };

  const handleSaveAutoMeterValueConfig = (config: AutoMeterValueConfig) => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    connector.autoMeterValueConfig = config;

    // Save to localStorage
    saveConnectorAutoMeterConfig(cp.id, connector_id, config);
  };

  const handleToggleAutoResetToAvailable = () => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    connector.autoResetToAvailable = !connector.autoResetToAvailable;
  };

  const handleOpenScenarioEditor = () => {
    setIsScenarioEditorOpen(true);
  };

  const handleRemoveConnector = () => {
    if (!cp) return;

    if (
      window.confirm(
        `Are you sure you want to remove Connector ${connector_id}?`,
      )
    ) {
      cp.removeConnector(connector_id);
    }
  };

  // Scenario handlers (multi-scenario support)
  const handleCloseScenarioEditor = useCallback(() => {
    setIsScenarioEditorOpen(false);

    // Reload all scenarios from storage
    if (cp) {
      const loadedScenarios = loadScenarios(cp.id, connector_id);
      if (loadedScenarios.length > 0) {
        // Keep the current scenario in editor, or switch to first if not found
        const currentScenario = scenario
          ? loadedScenarios.find((s) => s.id === scenario.id)
          : null;
        setScenario(currentScenario || loadedScenarios[0]);

        // Reload all scenarios in ScenarioManager
        const connector = cp.getConnector(connector_id);
        if (connector?.scenarioManager) {
          connector.scenarioManager.loadScenarios(loadedScenarios);
        }
      }
    }
  }, [cp, connector_id, scenario]);

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

  // Handle Escape key to close panel
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

  // Get battery capacity from transaction or use default
  const connector = cp?.getConnector(connector_id);
  const batteryCapacityKwh = connector?.transaction?.batteryCapacityKwh ?? 100; // Default 100kWh

  // Calculate charging level percentage (0-100%)
  // Prefer SoC if available, otherwise calculate from energy and battery capacity
  const chargingLevel =
    liveSoc !== null
      ? Math.min(100, Math.max(0, liveSoc))
      : Math.min(100, (liveMeterValue / (batteryCapacityKwh * 1000)) * 100);

  // Get battery color based on status and level
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

  // Handle card click - open side panel
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

        {/* Charging Visualization */}
        <div className="flex items-center gap-4 mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          {/* Battery Icon */}
          <div className="relative flex-shrink-0">
            <div className={`text-5xl ${getBatteryColor()}`}>🔋</div>
            {connectorStatus === ocpp.OCPPStatus.Charging ? (
              <div className="absolute -top-1 -right-1 text-xl animate-pulse">
                ⚡
              </div>
            ) : null}
          </div>

          {/* Status and Meter Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold text-primary">
                <ConnectorStatus status={connectorStatus} />
              </span>
              {/* rendering-conditional-render: use ternary to avoid 0 being rendered */}
              {transactionId != null && transactionId !== 0 ? (
                <span className="text-xs text-muted font-mono">
                  TX:{transactionId}
                </span>
              ) : null}
            </div>

            {/* Meter Value Progress Bar */}
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

      {/* MeterValue Curve Config Modal */}
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

      {/* Side Panel with Tabs */}
      {isScenarioEditorOpen && cp ? (
        <div className="fixed inset-0 z-[9999] flex justify-end pointer-events-none">
          {/* Semi-transparent overlay on the left - visual effect only, clicks pass through */}
          <div className="flex-1 bg-black bg-opacity-20 pointer-events-none" />

          {/* Side Panel */}
          <div
            className="bg-white dark:bg-gray-900 shadow-2xl h-full flex flex-row pointer-events-auto"
            style={{ width: `${panelWidth}vw` }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Resize Handle - Full Height */}
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

            {/* Content Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Tab Header */}
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
                  {/* Close Button - Always visible in tab header */}
                  <button
                    onClick={() => setIsScenarioEditorOpen(false)}
                    className="px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center justify-center"
                    title="Close Panel"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Panel Content */}
              <div className="flex-1 overflow-hidden">
                {activeTab === "connector" ? (
                  <div className="h-full flex flex-col">
                    {/* Connector Details Header */}
                    <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
                      <h2 className="text-lg font-bold text-primary">
                        Connector {connector_id} Details
                      </h2>
                      <p className="text-xs text-muted">{cp.id}</p>
                    </div>
                    {/* Connector Details Content */}
                    <div className="flex-1 overflow-y-auto p-4">
                      <ConnectorDetailsPanel
                        cp={cp}
                        connectorId={connector_id}
                        connectorStatus={connectorStatus}
                        transactionId={transactionId}
                        meterValue={meterValueInput}
                        setMeterValue={setMeterValueInput}
                        tagId={tagId}
                        setIdTag={setIdTag}
                        availability={availability}
                        autoMeterValueConfig={autoMeterValueConfig}
                        autoResetToAvailable={autoResetToAvailable}
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
                      chargePoint={cp}
                      connectorId={connector_id}
                      scenario={scenario}
                      scenarioId={scenario?.id}
                      executionContext={scenarioExecutionContext}
                      nodeProgress={nodeProgress}
                      onClose={handleCloseScenarioEditor}
                    />
                  </Suspense>
                ) : (
                  <div className="h-full flex flex-col">
                    {/* State Transition Viewer Header */}
                    <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
                      <h2 className="text-lg font-bold text-primary">
                        State Transition Diagram (OCPP 1.6J)
                      </h2>
                      <p className="text-xs text-muted">
                        Connector {connector_id}
                      </p>
                    </div>
                    {/* State Transition Viewer Content */}
                    <div className="flex-1 overflow-hidden">
                      {cp.getConnector(connector_id) ? (
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
                            connector={cp.getConnector(connector_id)!}
                            chargePoint={cp}
                          />
                        </Suspense>
                      ) : null}
                    </div>
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
