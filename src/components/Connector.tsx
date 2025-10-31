import React, { useState, useEffect, useRef, useCallback } from "react";
import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import {
  ScenarioMode,
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";
import MeterValueCurveModal from "./MeterValueCurveModal.tsx";
import ScenarioEditor from "./scenario/ScenarioEditor.tsx";
import StateTransitionViewer from "./state-transition/StateTransitionViewer.tsx";
import { GitBranch } from "lucide-react";
import { saveConnectorAutoMeterConfig } from "../utils/connectorStorage";
import {
  loadScenarios,
  createDefaultScenario,
} from "../utils/scenarioStorage";
import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";

interface ConnectorProps {
  id: number;
  cp: ChargePoint | null;
  idTag: string;
}

// Helper Components
const ConnectorStatus: React.FC<{ status: string }> = ({ status }) => {
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
};

const ConnectorAvailability: React.FC<{ availability: OCPPAvailability }> = ({
  availability,
}) => {
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
};

interface ConnectorDetailsPanelProps {
  cp: ChargePoint;
  connectorId: number;
  connectorStatus: ocpp.OCPPStatus;
  cpTransactionID: number | null;
  meterValue: number;
  setMeterValue: (value: number) => void;
  tagId: string;
  setIdTag: (tagId: string) => void;
  availability: OCPPAvailability;
  autoMeterValueConfig: AutoMeterValueConfig | null;
  onStartTransaction: () => void;
  onStopTransaction: () => void;
  onIncreaseMeterValue: () => void;
  onSendMeterValue: () => void;
  onToggleAutoMeterValue: () => void;
  onOpenConfigModal: () => void;
  onStatusNotification: () => void;
}

const ConnectorDetailsPanel: React.FC<ConnectorDetailsPanelProps> = ({
  cp,
  connectorId,
  connectorStatus,
  cpTransactionID,
  meterValue,
  setMeterValue,
  tagId,
  setIdTag,
  availability,
  autoMeterValueConfig,
  onStartTransaction,
  onStopTransaction,
  onIncreaseMeterValue,
  onSendMeterValue,
  onToggleAutoMeterValue,
  onOpenConfigModal,
  onStatusNotification,
}) => {
  const connector = cp.getConnector(connectorId);
  const scenarioManager = connector?.scenarioManager;

  // Get scenario status
  const activeScenarioIds = scenarioManager?.getActiveScenarioIds() || [];
  const hasActiveScenario = activeScenarioIds.length > 0;

  return (
    <div className="space-y-4">
      {/* Scenario Status */}
      <div className="panel p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950 border-l-4 border-blue-500">
        <h3 className="text-sm font-semibold mb-3 text-primary flex items-center gap-2">
          ⚙️ Scenario Status
        </h3>
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted">Active Scenarios:</span>
            <span className={`text-sm font-semibold ${hasActiveScenario ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
              {hasActiveScenario ? `${activeScenarioIds.length} Running` : 'None'}
            </span>
          </div>
          {hasActiveScenario && (
            <div className="mt-2 text-xs text-muted space-y-1">
              {activeScenarioIds.map((id, idx) => (
                <div key={id} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                  <span>Scenario {idx + 1}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Status Information */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold mb-3 text-primary">📊 Status Information</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm text-muted">Status:</span>
            <span className="text-sm font-semibold">
              <ConnectorStatus status={connectorStatus} />
            </span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm text-muted">Availability:</span>
            <span className="text-sm font-semibold">
              <ConnectorAvailability availability={availability} />
            </span>
          </div>
          {cpTransactionID !== null && cpTransactionID !== 0 && (
            <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
              <span className="text-sm text-muted">Transaction ID:</span>
              <span className="text-sm font-mono font-semibold bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded">
                {cpTransactionID}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-muted">Meter Value:</span>
            <span className="text-sm font-mono font-semibold">{meterValue.toLocaleString()} Wh</span>
          </div>
        </div>
        <button
          onClick={onStatusNotification}
          className="btn-secondary w-full mt-3 text-sm"
        >
          📤 Send StatusNotification
        </button>
      </div>

      {/* Auto Meter Value Status */}
      {autoMeterValueConfig && (
        <div className="panel p-4 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-950 dark:to-pink-950 border-l-4 border-purple-500">
          <h3 className="text-sm font-semibold mb-3 text-primary flex items-center gap-2">
            📈 Auto MeterValue Status
          </h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted">Status:</span>
              <span className={`text-sm font-semibold flex items-center gap-1 ${autoMeterValueConfig.enabled ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
                {autoMeterValueConfig.enabled && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>}
                {autoMeterValueConfig.enabled ? 'Active' : 'Inactive'}
              </span>
            </div>
            {autoMeterValueConfig.enabled && (
              <>
                <div className="flex items-center justify-between py-1 border-t border-gray-200 dark:border-gray-700">
                  <span className="text-xs text-muted">Send Interval:</span>
                  <span className="text-xs font-mono bg-purple-100 dark:bg-purple-900 px-2 py-1 rounded">
                    {autoMeterValueConfig.intervalSeconds}s
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted">Curve Points:</span>
                  <span className="text-xs font-mono">{autoMeterValueConfig.curvePoints.length} points</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted">Auto Calculate:</span>
                  <span className="text-xs">{autoMeterValueConfig.autoCalculateInterval ? 'Yes' : 'No'}</span>
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                onClick={onToggleAutoMeterValue}
                className={`text-sm ${autoMeterValueConfig.enabled ? 'btn-warning' : 'btn-success'}`}
              >
                {autoMeterValueConfig.enabled ? '⏸️ Disable' : '▶️ Enable'}
              </button>
              <button
                onClick={onOpenConfigModal}
                className="btn-secondary text-sm"
              >
                ⚙️ Configure
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Controls */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold mb-3 text-primary">💳 Transaction</h3>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-muted mb-1">ID Tag</label>
            <input
              type="text"
              value={tagId}
              onChange={(e) => setIdTag(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-primary focus:ring-2 focus:ring-blue-500"
              placeholder="Enter ID Tag"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onStartTransaction}
              disabled={connectorStatus === ocpp.OCPPStatus.Charging}
              className="btn-success text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ▶️ Start
            </button>
            <button
              onClick={onStopTransaction}
              disabled={connectorStatus !== ocpp.OCPPStatus.Charging}
              className="btn-warning text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ⏹️ Stop
            </button>
          </div>
        </div>
      </div>

      {/* Meter Value Controls */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold mb-3 text-primary">⚡ Meter Value Controls</h3>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-muted mb-1">Manual Value (Wh)</label>
            <input
              type="number"
              value={meterValue}
              onChange={(e) => setMeterValue(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-primary font-mono focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onIncreaseMeterValue}
              className="btn-info text-sm"
            >
              ➕ +10 Wh
            </button>
            <button
              onClick={onSendMeterValue}
              className="btn-secondary text-sm"
            >
              📤 Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const Connector: React.FC<ConnectorProps> = ({
  id: connector_id,
  cp,
  idTag,
}) => {
  const [cpTransactionID, setCpTransactionID] = useState<number | null>(0);
  const [connectorStatus, setConnectorStatus] = useState<ocpp.OCPPStatus>(
    ocpp.OCPPStatus.Unavailable,
  );
  const [availability, setAvailability] =
    useState<OCPPAvailability>("Operative");
  const [meterValue, setMeterValue] = useState<number>(0);
  const [tagId, setIdTag] = useState<string>(idTag);
  const [autoMeterValueConfig, setAutoMeterValueConfig] =
    useState<AutoMeterValueConfig | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [mode, setMode] = useState<ScenarioMode>("manual");
  const [isScenarioEditorOpen, setIsScenarioEditorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"connector" | "scenario" | "stateTransition">("connector");
  const [panelWidth, setPanelWidth] = useState(50); // Default 50vw
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Scenario state (single scenario per connector)
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [isScenarioActive, setIsScenarioActive] = useState(false);
  const [scenarioExecutionContext, setScenarioExecutionContext] = useState<ScenarioExecutionContext | null>(null);
  const [nodeProgress, setNodeProgress] = useState<Record<string, { remaining: number; total: number }>>({});

  useEffect(() => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    // Subscribe to connector events using EventEmitter
    const unsubStatus = connector.events.on("statusChange", (data) => {
      setConnectorStatus(data.status);
    });

    const unsubTransactionId = connector.events.on(
      "transactionIdChange",
      (data) => {
        setCpTransactionID(data.transactionId);
      },
    );

    const unsubMeterValue = connector.events.on("meterValueChange", (data) => {
      setMeterValue(data.meterValue);
    });

    const unsubAvailability = connector.events.on(
      "availabilityChange",
      (data) => {
        setAvailability(data.availability);
      },
    );

    const unsubAutoMeterValue = connector.events.on(
      "autoMeterValueChange",
      (data) => {
        setAutoMeterValueConfig(data.config);
      },
    );

    const unsubMode = connector.events.on("modeChange", (data) => {
      setMode(data.mode);
    });

    // Initial state
    setConnectorStatus(connector.status as ocpp.OCPPStatus);
    setAvailability(connector.availability);
    setMeterValue(connector.meterValue);
    setAutoMeterValueConfig(connector.autoMeterValueConfig);
    setMode(connector.mode);

    // Set callback for auto MeterValue send
    connector.setOnMeterValueSend((connId) => {
      if (cp) {
        cp.sendMeterValue(connId);
      }
    });

    // Cleanup function
    return () => {
      unsubStatus();
      unsubTransactionId();
      unsubMeterValue();
      unsubAvailability();
      unsubAutoMeterValue();
      unsubMode();
    };
  }, [connector_id, cp]);

  // Initialize ScenarioManager
  useEffect(() => {
    if (!cp) return;

    const connector = cp.getConnector(connector_id);
    if (!connector) return;

    // Load all scenarios from storage (new multi-scenario storage)
    const loadedScenarios = loadScenarios(cp.id, connector_id);
    if (loadedScenarios.length > 0) {
      // Set the first scenario as active in the editor
      setScenario(loadedScenarios[0]);
    }

    // Create ScenarioExecutorCallbacks
    const callbacks: ScenarioExecutorCallbacks = {
      onStatusChange: async (status) => {
        // Use updateConnectorStatus to send StatusNotification message
        cp.updateConnectorStatus(connector_id, status);
      },
      onStartTransaction: async (tagId) => {
        cp.startTransaction(tagId, connector_id);
      },
      onStopTransaction: async () => {
        cp.stopTransaction(connector_id);
      },
      onSetMeterValue: (value) => {
        cp.setMeterValue(connector_id, value);
      },
      onSendMeterValue: async () => {
        cp.sendMeterValue(connector_id);
      },
      onSendNotification: async (messageType, payload) => {
        if (!cp) return;

        switch (messageType) {
          case "Heartbeat":
            cp.sendHeartbeat();
            break;
          case "StatusNotification":
            if (payload?.status) {
              cp.updateConnectorStatus(connector_id, payload.status as ocpp.OCPPStatus);
            }
            break;
          default:
            console.warn(`Unhandled scenario notification type: ${messageType}`, payload);
        }
      },
      onConnectorPlug: async (action) => {
        // TODO: Implement connector plug/unplug
        console.log(`Connector ${action}`, connector_id);
      },
      onDelay: async (seconds) => {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      },
      onWaitForRemoteStart: async (timeout) => {
        // TODO: Implement waiting for RemoteStartTransaction
        return "default-tag";
      },
      onWaitForStatus: async (targetStatus, timeout) => {
        // TODO: Implement waiting for status change
        console.log(`Waiting for status: ${targetStatus}`, timeout);
      },
      onNodeProgress: (nodeId, remaining, total) => {
        setNodeProgress((prev) => ({
          ...prev,
          [nodeId]: { remaining, total },
        }));
      },
    };

    // Create and set ScenarioManager
    const scenarioManager = new ScenarioManager(connector, cp, callbacks);
    if (loadedScenarios.length > 0) {
      scenarioManager.loadScenarios(loadedScenarios);
    }
    connector.setScenarioManager(scenarioManager);

    // Subscribe to scenario changes - poll active scenario periodically
    const intervalId = setInterval(() => {
      if (connector.scenarioManager) {
        const activeIds = connector.scenarioManager.getActiveScenarioIds();
        // Update isScenarioActive based on whether ANY scenario is active
        setIsScenarioActive(activeIds.length > 0);

        // If there's a currently selected scenario in the editor, get its execution context
        if (scenario && activeIds.includes(scenario.id)) {
          const context = connector.scenarioManager.getScenarioExecutionContext(scenario.id);
          setScenarioExecutionContext(context);
        } else {
          setScenarioExecutionContext(null);
        }
      }
    }, 500);

    return () => {
      clearInterval(intervalId);
      if (connector.scenarioManager) {
        connector.scenarioManager.destroy();
      }
    };
  }, [connector_id, cp]);

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
      setMeterValue(meterValue + 10);
      cp.setMeterValue(connector_id, meterValue);
    }
  };

  const handleSendMeterValue = () => {
    if (cp) {
      setMeterValue(meterValue);
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

  const handleOpenScenarioEditor = () => {
    setIsScenarioEditorOpen(true);
  };

  const handleRemoveConnector = () => {
    if (!cp) return;

    if (window.confirm(`Connector ${connector_id} を削除してもよろしいですか？`)) {
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
        const currentScenario = scenario ? loadedScenarios.find(s => s.id === scenario.id) : null;
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
      const newWidth = Math.min(95, Math.max(30, resizeStartWidth.current + deltaVw));
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

  return (
    <div className="panel cursor-pointer hover:shadow-lg transition-shadow" onClick={handleOpenScenarioEditor}>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base font-semibold text-primary">Connector {connector_id}</h3>
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
        <div className="panel-border mb-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-semibold text-primary">Status:</label>
            {connectorStatus === ocpp.OCPPStatus.Charging && (
              <div className="flex items-center gap-1">
                <span className="text-muted text-xs">TX:</span>
                <span className="font-mono text-xs text-secondary">{cpTransactionID}</span>
              </div>
            )}
          </div>
          <p className="text-xl font-bold text-center">
            <ConnectorStatus status={connectorStatus} />
          </p>
        </div>
      </div>

      <div className="text-sm text-muted text-center py-2">
        <span className="inline-flex items-center gap-1">
          ⚙️ Click to open Editor (Scenario / State Diagram)
        </span>
      </div>

      {/* MeterValue Curve Config Modal */}
      {isConfigModalOpen && autoMeterValueConfig && (
        <MeterValueCurveModal
          isOpen={isConfigModalOpen}
          onClose={() => setIsConfigModalOpen(false)}
          initialConfig={autoMeterValueConfig}
          onSave={handleSaveAutoMeterValueConfig}
        />
      )}

      {/* Side Panel with Tabs */}
      {isScenarioEditorOpen && cp && (
        <div className="fixed inset-0 z-[9999] flex justify-end pointer-events-none">
          {/* Semi-transparent overlay on the left - visual effect only, clicks pass through */}
          <div
            className="flex-1 bg-black bg-opacity-20 pointer-events-none"
          />

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
                        : "bg-gray-50 dark:bg-gray-900 text-muted dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    🔌 Connector Details
                  </button>
                  <button
                    onClick={() => setActiveTab("scenario")}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                      activeTab === "scenario"
                        ? "bg-white dark:bg-gray-800 text-primary dark:text-white border-b-2 border-blue-500"
                        : "bg-gray-50 dark:bg-gray-900 text-muted dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    ⚙️ Scenario
                  </button>
                  <button
                    onClick={() => setActiveTab("stateTransition")}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                      activeTab === "stateTransition"
                        ? "bg-white dark:bg-gray-800 text-primary dark:text-white border-b-2 border-blue-500"
                        : "bg-gray-50 dark:bg-gray-900 text-muted dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    <GitBranch className="h-4 w-4" /> 状態遷移
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
                      <p className="text-xs text-muted">
                        {cp.id}
                      </p>
                    </div>
                    {/* Connector Details Content */}
                    <div className="flex-1 overflow-y-auto p-4">
                      <ConnectorDetailsPanel
                        cp={cp}
                        connectorId={connector_id}
                        connectorStatus={connectorStatus}
                        cpTransactionID={cpTransactionID}
                        meterValue={meterValue}
                        setMeterValue={setMeterValue}
                        tagId={tagId}
                        setIdTag={setIdTag}
                        availability={availability}
                        autoMeterValueConfig={autoMeterValueConfig}
                        onStartTransaction={handleStartTransaction}
                        onStopTransaction={handleStopTransaction}
                        onIncreaseMeterValue={handleIncreaseMeterValue}
                        onSendMeterValue={handleSendMeterValue}
                        onToggleAutoMeterValue={handleToggleAutoMeterValue}
                        onOpenConfigModal={() => setIsConfigModalOpen(true)}
                        onStatusNotification={handleStatusNotification}
                      />
                    </div>
                  </div>
                ) : activeTab === "scenario" ? (
                  <ScenarioEditor
                    chargePoint={cp}
                    connectorId={connector_id}
                    scenarioId={scenario?.id}
                    executionContext={scenarioExecutionContext}
                    nodeProgress={nodeProgress}
                    onClose={handleCloseScenarioEditor}
                  />
                ) : (
                  <div className="h-full flex flex-col">
                    {/* State Transition Viewer Header */}
                    <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
                      <h2 className="text-lg font-bold text-primary">
                        状態遷移図 (OCPP 1.6J)
                      </h2>
                      <p className="text-xs text-muted">
                        Connector {connector_id}
                      </p>
                    </div>
                    {/* State Transition Viewer Content */}
                    <div className="flex-1 overflow-hidden">
                      {cp.getConnector(connector_id) && (
                        <StateTransitionViewer
                          connector={cp.getConnector(connector_id)!}
                          chargePoint={cp}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Connector;
