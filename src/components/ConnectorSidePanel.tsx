import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
} from "react";
import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";
import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import { useConnectorView } from "../data/hooks/useConnectorView";
import { useScenarios } from "../data/hooks/useScenarios";
import { EVSettingsPanel } from "./EVSettingsPanel";

// Dynamic imports for heavy components (bundle-dynamic-imports)
const StateTransitionViewer = lazy(
  () => import("./state-transition/StateTransitionViewer"),
);
const ScenarioEditor = lazy(() => import("./scenario/ScenarioEditor"));
import {
  ChevronRight,
  ChevronLeft,
  X,
  GitBranch,
  Settings,
  Zap,
} from "lucide-react";

interface ConnectorSidePanelProps {
  chargePoint: ChargePoint;
  connectorId: number;
  idTag: string;
  onClose: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  panelWidth: number;
  onWidthChange: (width: number) => void;
}

// Helper component for status color
const getStatusColor = (status: string) => {
  switch (status) {
    case OCPPStatus.Available:
      return "bg-green-500";
    case OCPPStatus.Charging:
      return "bg-blue-500";
    case OCPPStatus.Preparing:
      return "bg-yellow-500";
    case OCPPStatus.Faulted:
      return "bg-red-500";
    case OCPPStatus.Unavailable:
      return "bg-gray-500";
    default:
      return "bg-gray-400";
  }
};

// Collapsed Panel View
const CollapsedPanelView: React.FC<{
  connectorId: number;
  status: OCPPStatus;
  soc: number | null;
  onExpand: () => void;
  onClose: () => void;
}> = ({ connectorId, status, soc, onExpand, onClose }) => {
  return (
    <div className="h-full flex flex-col items-center py-4 px-2 bg-white dark:bg-gray-900">
      <button
        onClick={onExpand}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
        title="Expand panel"
      >
        <ChevronLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
      </button>
      <div className="mt-4 text-sm font-bold text-gray-900 dark:text-white">
        C{connectorId}
      </div>
      <div
        className={`mt-3 w-4 h-4 rounded-full ${getStatusColor(status)}`}
        title={status}
      />
      {soc !== null && (
        <div className="mt-3 text-xs font-mono text-gray-600 dark:text-gray-400">
          {soc.toFixed(0)}%
        </div>
      )}
      <button
        onClick={onClose}
        className="mt-auto p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
        title="Close panel"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
};

type TabType = "details" | "scenario" | "stateTransition";

// Full Panel Content with Tabs
const FullPanelContent: React.FC<{
  chargePoint: ChargePoint;
  connectorId: number;
  idTag: string;
  onCollapse: () => void;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  isResizing: boolean;
}> = ({
  chargePoint,
  connectorId,
  idTag,
  onCollapse,
  onClose,
  onResizeStart,
  isResizing,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>("details");
  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    autoMeterValueConfig,
    autoResetToAvailable,
    evSettings,
  } = useConnectorView(chargePoint, connectorId);

  const { scenarios } = useScenarios(chargePoint.id, connectorId);
  const connector = chargePoint.getConnector(connectorId);
  const [meterValueInput, setMeterValueInput] =
    useState<number>(liveMeterValue);
  const [tagIdInput, setTagIdInput] = useState<string>(idTag);
  const [duration, setDuration] = useState<string>("00:00:00");
  const [transactionStartTime, setTransactionStartTime] = useState<string>("");

  // Scenario state
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [scenarioExecutionContext, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [nodeProgress, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});
  const scenarioManagerRef = useRef<ScenarioManager | null>(null);
  const scenarioRef = useRef<ScenarioDefinition | null>(null);

  useEffect(() => {
    setMeterValueInput(liveMeterValue);
  }, [liveMeterValue]);

  // Track transaction duration
  useEffect(() => {
    if (connectorStatus !== OCPPStatus.Charging || !connector?.transaction) {
      setDuration("00:00:00");
      setTransactionStartTime("");
      return;
    }

    const startTime = connector.transaction.startTime;
    if (startTime) {
      setTransactionStartTime(startTime.toLocaleTimeString());
    }

    const interval = setInterval(() => {
      const currentConnector = chargePoint.getConnector(connectorId);
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
  }, [connectorStatus, connector?.transaction, chargePoint, connectorId]);

  // Setup ScenarioManager
  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);

  useEffect(() => {
    if (!connector) return;

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
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
      chargePoint,
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
  }, [connector, chargePoint, connectorId]);

  // Load scenarios
  useEffect(() => {
    if (scenarios.length > 0) {
      setScenario((current) => {
        const match = current
          ? scenarios.find((s) => s.id === current.id)
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
    }
  }, [scenarios]);

  // Handlers
  const handleStartTransaction = useCallback(() => {
    chargePoint.startTransaction(tagIdInput, connectorId);
  }, [chargePoint, connectorId, tagIdInput]);

  const handleStopTransaction = useCallback(() => {
    chargePoint.stopTransaction(connectorId);
  }, [chargePoint, connectorId]);

  const handleIncreaseMeterValue = useCallback(() => {
    const nextValue = meterValueInput + 10;
    setMeterValueInput(nextValue);
    chargePoint.setMeterValue(connectorId, nextValue);
  }, [chargePoint, connectorId, meterValueInput]);

  const handleSendMeterValue = useCallback(() => {
    chargePoint.setMeterValue(connectorId, meterValueInput);
    chargePoint.sendMeterValue(connectorId);
  }, [chargePoint, connectorId, meterValueInput]);

  const handleToggleAutoMeterValue = useCallback(() => {
    if (!autoMeterValueConfig || !connector) return;
    connector.autoMeterValueConfig = {
      ...autoMeterValueConfig,
      enabled: !autoMeterValueConfig.enabled,
    };
  }, [connector, autoMeterValueConfig]);

  const handleToggleAutoResetToAvailable = useCallback(() => {
    if (!connector) return;
    connector.autoResetToAvailable = !connector.autoResetToAvailable;
  }, [connector]);

  const handleEVSettingsChange = useCallback(
    (settings: EVSettings) => {
      if (!connector) return;
      connector.evSettings = settings;
    },
    [connector],
  );

  const isCharging = connectorStatus === OCPPStatus.Charging;

  return (
    <div className="h-full flex flex-row bg-white dark:bg-gray-900">
      {/* Resize Handle */}
      <div
        className={`w-2 bg-gray-200 dark:bg-gray-700 hover:bg-blue-500 dark:hover:bg-blue-400 cursor-col-resize flex-shrink-0 transition-colors ${
          isResizing ? "bg-blue-500 dark:bg-blue-400" : ""
        }`}
        onMouseDown={onResizeStart}
      >
        <div className="w-full h-full flex items-center justify-center">
          <div className="w-0.5 h-12 bg-gray-400 dark:bg-gray-500 rounded-full" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab Header */}
        <div className="border-b border-gray-200 dark:border-gray-700 flex-shrink-0 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center">
            <button
              onClick={onCollapse}
              className="p-3 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title="Collapse panel"
            >
              <ChevronRight className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            <button
              onClick={() => setActiveTab("details")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === "details"
                  ? "bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              <Settings className="w-4 h-4" />
              Details
            </button>
            <button
              onClick={() => setActiveTab("scenario")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === "scenario"
                  ? "bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              <Zap className="w-4 h-4" />
              Scenario
            </button>
            <button
              onClick={() => setActiveTab("stateTransition")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === "stateTransition"
                  ? "bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              <GitBranch className="w-4 h-4" />
              State
            </button>
            <button
              onClick={onClose}
              className="p-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Close panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "details" && (
            <div className="h-full overflow-y-auto p-4 space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                    Connector {connectorId}
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {chargePoint.id}
                  </p>
                </div>
              </div>

              {/* Status Dashboard */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">
                  Status Dashboard
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white dark:bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Status
                    </div>
                    <div className="flex items-center justify-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${getStatusColor(connectorStatus)}`}
                      />
                      <span className="text-sm font-bold text-gray-900 dark:text-white">
                        {connectorStatus}
                      </span>
                    </div>
                  </div>
                  <div className="bg-white dark:bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Meter
                    </div>
                    <div className="text-sm font-bold font-mono text-gray-900 dark:text-white">
                      {liveMeterValue.toLocaleString()}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Wh
                    </div>
                  </div>
                  <div className="bg-white dark:bg-gray-700 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Availability
                    </div>
                    <div className="flex items-center justify-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${availability === "Operative" ? "bg-green-500" : "bg-red-500"}`}
                      />
                      <span className="text-sm font-bold text-gray-900 dark:text-white">
                        {availability}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Active Transaction */}
              {isCharging && transactionId !== null && transactionId !== 0 && (
                <div className="bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/50 dark:to-emerald-950/50 rounded-lg p-4 border-l-4 border-green-500">
                  <h3 className="text-sm font-semibold mb-3 text-green-700 dark:text-green-300 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
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
                        {connector?.transaction?.tagId || tagIdInput}
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
                        {(liveMeterValue / 1000).toFixed(2)} kWh
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* EV Settings */}
              <EVSettingsPanel
                settings={evSettings}
                currentSoc={liveSoc}
                meterValue={liveMeterValue}
                isCharging={isCharging}
                onChange={handleEVSettingsChange}
              />

              {/* Controls */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <h4 className="text-xs font-semibold mb-2 text-gray-500 dark:text-gray-400">
                    Transaction
                  </h4>
                  <input
                    type="text"
                    value={tagIdInput}
                    onChange={(e) => setTagIdInput(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 mb-2"
                    placeholder="ID Tag"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={handleStartTransaction}
                      disabled={isCharging}
                      className="text-xs py-1.5 px-2 bg-green-500 hover:bg-green-600 text-white rounded disabled:opacity-50"
                    >
                      Start
                    </button>
                    <button
                      onClick={handleStopTransaction}
                      disabled={!isCharging}
                      className="text-xs py-1.5 px-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded disabled:opacity-50"
                    >
                      Stop
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                  <h4 className="text-xs font-semibold mb-2 text-gray-500 dark:text-gray-400">
                    Meter Value
                  </h4>
                  <input
                    type="number"
                    value={meterValueInput}
                    onChange={(e) => setMeterValueInput(Number(e.target.value))}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono mb-2"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={handleIncreaseMeterValue}
                      className="text-xs py-1.5 px-2 bg-blue-500 hover:bg-blue-600 text-white rounded"
                    >
                      +10 Wh
                    </button>
                    <button
                      onClick={handleSendMeterValue}
                      className="text-xs py-1.5 px-2 bg-gray-500 hover:bg-gray-600 text-white rounded"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>

              {/* Status Control */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <h4 className="text-xs font-semibold mb-2 text-gray-500 dark:text-gray-400">
                  Status Control
                </h4>
                <select
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      chargePoint.updateConnectorStatus(
                        connectorId,
                        e.target.value as OCPPStatus,
                      );
                      e.target.value = "";
                    }
                  }}
                >
                  <option value="">Change Status...</option>
                  <option value={OCPPStatus.Available}>Available</option>
                  <option value={OCPPStatus.Preparing}>Preparing</option>
                  <option value={OCPPStatus.Charging}>Charging</option>
                  <option value={OCPPStatus.SuspendedEVSE}>
                    SuspendedEVSE
                  </option>
                  <option value={OCPPStatus.SuspendedEV}>SuspendedEV</option>
                  <option value={OCPPStatus.Finishing}>Finishing</option>
                  <option value={OCPPStatus.Reserved}>Reserved</option>
                  <option value={OCPPStatus.Unavailable}>Unavailable</option>
                  <option value={OCPPStatus.Faulted}>Faulted</option>
                </select>
              </div>

              {/* Settings */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <h4 className="text-xs font-semibold mb-3 text-gray-500 dark:text-gray-400">
                  Settings
                </h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between py-1">
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      Auto Available on Stop
                    </span>
                    <button
                      onClick={handleToggleAutoResetToAvailable}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        autoResetToAvailable
                          ? "bg-green-500"
                          : "bg-gray-300 dark:bg-gray-600"
                      }`}
                    >
                      <span
                        className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                          autoResetToAvailable
                            ? "translate-x-5"
                            : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                  {autoMeterValueConfig && (
                    <div className="flex items-center justify-between py-1 border-t border-gray-200 dark:border-gray-700">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          Auto MeterValue
                        </span>
                        {autoMeterValueConfig.enabled && (
                          <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                            Active
                          </span>
                        )}
                      </div>
                      <button
                        onClick={handleToggleAutoMeterValue}
                        className={`text-xs px-2 py-1 rounded ${
                          autoMeterValueConfig.enabled
                            ? "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300"
                            : "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300"
                        }`}
                      >
                        {autoMeterValueConfig.enabled ? "Disable" : "Enable"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* rendering-conditional-render + bundle-dynamic-imports */}
          {activeTab === "scenario" ? (
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center">
                  <div className="text-muted">Loading Scenario Editor...</div>
                </div>
              }
            >
              <ScenarioEditor
                chargePoint={chargePoint}
                connectorId={connectorId}
                scenario={scenario}
                scenarioId={scenario?.id}
                executionContext={scenarioExecutionContext}
                nodeProgress={nodeProgress}
                onClose={() => setActiveTab("details")}
              />
            </Suspense>
          ) : null}

          {activeTab === "stateTransition" && connector ? (
            <div className="h-full flex flex-col">
              <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  State Transition Diagram
                </h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  OCPP 1.6J Connector {connectorId}
                </p>
              </div>
              <div className="flex-1">
                <Suspense
                  fallback={
                    <div className="h-full flex items-center justify-center">
                      <div className="text-muted">Loading State Diagram...</div>
                    </div>
                  }
                >
                  <StateTransitionViewer
                    connector={connector}
                    chargePoint={chargePoint}
                  />
                </Suspense>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const ConnectorSidePanel: React.FC<ConnectorSidePanelProps> = ({
  chargePoint,
  connectorId,
  idTag,
  onClose,
  isCollapsed,
  onToggleCollapse,
  panelWidth,
  onWidthChange,
}) => {
  const { status, soc } = useConnectorView(chargePoint, connectorId);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Handle resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      setIsResizing(true);
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = panelWidth;
      e.preventDefault();
    },
    [panelWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = resizeStartX.current - e.clientX;
      const viewportWidth = window.innerWidth;
      const deltaVw = (deltaX / viewportWidth) * 100;
      const newWidth = Math.min(
        90,
        Math.max(25, resizeStartWidth.current + deltaVw),
      );
      onWidthChange(newWidth);
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
  }, [isResizing, onWidthChange]);

  if (isCollapsed) {
    return (
      <CollapsedPanelView
        connectorId={connectorId}
        status={status}
        soc={soc}
        onExpand={onToggleCollapse}
        onClose={onClose}
      />
    );
  }

  return (
    <FullPanelContent
      chargePoint={chargePoint}
      connectorId={connectorId}
      idTag={idTag}
      onCollapse={onToggleCollapse}
      onClose={onClose}
      onResizeStart={handleResizeStart}
      isResizing={isResizing}
    />
  );
};

export default ConnectorSidePanel;
