import React, { useState, useEffect, useRef, useCallback } from "react";
import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import * as ocpp from "../cp/domain/types/OcppTypes";
import { OCPPAvailability } from "../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";
import MeterValueCurveModal from "./MeterValueCurveModal.tsx";
import ScenarioEditor from "./scenario/ScenarioEditor.tsx";
import StateTransitionViewer from "./state-transition/StateTransitionViewer.tsx";
import { GitBranch } from "lucide-react";
import { saveConnectorAutoMeterConfig } from "../utils/connectorStorage";
import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";
import { useScenarios } from "../data/hooks/useScenarios";
import { useConnectorView } from "../data/hooks/useConnectorView";

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
  transactionId: number | null;
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
  transactionId,
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

  // Get scenario status with reactive polling
  const [activeScenarioIds, setActiveScenarioIds] = useState<string[]>([]);

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
            <span
              className={`text-sm font-semibold ${hasActiveScenario ? "text-green-600 dark:text-green-400" : "text-gray-500"}`}
            >
              {hasActiveScenario
                ? `${activeScenarioIds.length} Running`
                : "None"}
            </span>
          </div>
          {hasActiveScenario && (
            <div className="mt-2 text-xs text-muted space-y-1">
              {activeScenarioIds.map((id) => {
                const scenario = scenarioManager?.getScenario(id);
                const name = scenario?.name || id;
                return (
                  <div key={id} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                    <span>{name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Status Information */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold mb-3 text-primary">
          📊 Status Information
        </h3>
        <div className="space-y-2">
          <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Status:
            </span>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              <ConnectorStatus status={connectorStatus} />
            </span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Availability:
            </span>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              <ConnectorAvailability availability={availability} />
            </span>
          </div>
          {transactionId !== null && transactionId !== 0 && (
            <div className="flex justify-between items-center py-1 border-b border-gray-200 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Transaction ID:
              </span>
              <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100 bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded">
                {transactionId}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Meter Value:
            </span>
            <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
              {meterValue.toLocaleString()} Wh
            </span>
          </div>
        </div>

        {/* Status Change Selector */}
        <div className="mt-3">
          <select
            className="input-base text-sm w-full font-medium text-gray-900 dark:text-gray-100"
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
            <option value="" className="text-gray-500 dark:text-gray-400">
              Change Status...
            </option>
            <option
              value={ocpp.OCPPStatus.Available}
              className="text-gray-900 dark:text-gray-100"
            >
              Available
            </option>
            <option
              value={ocpp.OCPPStatus.Preparing}
              className="text-gray-900 dark:text-gray-100"
            >
              Preparing
            </option>
            <option
              value={ocpp.OCPPStatus.Charging}
              className="text-gray-900 dark:text-gray-100"
            >
              Charging
            </option>
            <option
              value={ocpp.OCPPStatus.SuspendedEVSE}
              className="text-gray-900 dark:text-gray-100"
            >
              SuspendedEVSE
            </option>
            <option
              value={ocpp.OCPPStatus.SuspendedEV}
              className="text-gray-900 dark:text-gray-100"
            >
              SuspendedEV
            </option>
            <option
              value={ocpp.OCPPStatus.Finishing}
              className="text-gray-900 dark:text-gray-100"
            >
              Finishing
            </option>
            <option
              value={ocpp.OCPPStatus.Reserved}
              className="text-gray-900 dark:text-gray-100"
            >
              Reserved
            </option>
            <option
              value={ocpp.OCPPStatus.Unavailable}
              className="text-gray-900 dark:text-gray-100"
            >
              Unavailable
            </option>
            <option
              value={ocpp.OCPPStatus.Faulted}
              className="text-gray-900 dark:text-gray-100"
            >
              Faulted
            </option>
          </select>
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
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Status:
              </span>
              <span
                className={`text-sm font-semibold flex items-center gap-1 ${autoMeterValueConfig.enabled ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-400"}`}
              >
                {autoMeterValueConfig.enabled && (
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                )}
                {autoMeterValueConfig.enabled ? "Active" : "Inactive"}
              </span>
            </div>
            {autoMeterValueConfig.enabled && (
              <>
                <div className="flex items-center justify-between py-1 border-t border-gray-200 dark:border-gray-700">
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    Send Interval:
                  </span>
                  <span className="text-xs font-mono text-gray-900 dark:text-gray-100 bg-purple-100 dark:bg-purple-900 px-2 py-1 rounded">
                    {autoMeterValueConfig.intervalSeconds}s
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    Curve Points:
                  </span>
                  <span className="text-xs font-mono text-gray-900 dark:text-gray-100">
                    {autoMeterValueConfig.curvePoints.length} points
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    Auto Calculate:
                  </span>
                  <span className="text-xs text-gray-900 dark:text-gray-100">
                    {autoMeterValueConfig.autoCalculateInterval ? "Yes" : "No"}
                  </span>
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                onClick={onToggleAutoMeterValue}
                className={`text-sm ${autoMeterValueConfig.enabled ? "btn-warning" : "btn-success"}`}
              >
                {autoMeterValueConfig.enabled ? "⏸️ Disable" : "▶️ Enable"}
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
        <h3 className="text-sm font-semibold mb-3 text-primary">
          💳 Transaction
        </h3>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
              ID Tag
            </label>
            <input
              type="text"
              value={tagId}
              onChange={(e) => setIdTag(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
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
        <h3 className="text-sm font-semibold mb-3 text-primary">
          ⚡ Meter Value Controls
        </h3>
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
              Manual Value (Wh)
            </label>
            <input
              type="number"
              value={meterValue}
              onChange={(e) => setMeterValue(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onIncreaseMeterValue} className="btn-info text-sm">
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
  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    autoMeterValueConfig,
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

    const callbacks: ScenarioExecutorCallbacks = {
      onStatusChange: async (status) => {
        cp.updateConnectorStatus(connector_id, status);
      },
      onStartTransaction: async (tagId, batteryCapacityKwh, initialSoc) => {
        cp.startTransaction(
          tagId,
          connector_id,
          batteryCapacityKwh,
          initialSoc,
        );
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
      onStartAutoMeterValue: (config) => {
        const connector = cp.getConnector(connector_id);
        if (!connector) return;

        connector.startAutoMeterValue({
          kind: "increment",
          intervalSeconds: config.intervalSeconds,
          incrementValue: config.incrementValue,
          maxTimeSeconds: config.maxTimeSeconds,
          maxValue: config.maxValue,
        });
      },
      onStopAutoMeterValue: () => {
        const connector = cp.getConnector(connector_id);
        if (!connector) return;

        connector.stopAutoMeterValue();
      },
      onSendNotification: async (messageType, payload) => {
        if (!cp) return;

        switch (messageType) {
          case "Heartbeat":
            cp.sendHeartbeat();
            break;
          case "StatusNotification":
            if (payload?.status) {
              cp.updateConnectorStatus(
                connector_id,
                payload.status as ocpp.OCPPStatus,
              );
            }
            break;
          default:
            console.warn(
              `Unhandled scenario notification type: ${messageType}`,
              payload,
            );
        }
      },
      onConnectorPlug: async (action) => {
        console.log(`Connector ${action}`, connector_id);
      },
      onDelay: async (seconds) => {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      },
      onWaitForRemoteStart: async () => {
        return "default-tag";
      },
      onWaitForStatus: async (targetStatus, timeout) => {
        console.log(
          `[StatusTrigger] Waiting for status: ${targetStatus}`,
          timeout,
        );

        // Check if already at target status
        if (connector.status === targetStatus) {
          console.log(
            `[StatusTrigger] Already at target status: ${targetStatus}`,
          );
          return;
        }

        return new Promise<void>((resolve, reject) => {
          let timeoutId: NodeJS.Timeout | null = null;

          const statusChangeHandler = (data: {
            status: string;
            previousStatus: string;
          }) => {
            console.log(
              `[StatusTrigger] Status changed: ${data.previousStatus} → ${data.status}`,
            );
            if (data.status === targetStatus) {
              console.log(
                `[StatusTrigger] Target status reached: ${targetStatus}`,
              );
              if (timeoutId) clearTimeout(timeoutId);
              connector.events.off("statusChange", statusChangeHandler);
              resolve();
            }
          };

          connector.events.on("statusChange", statusChangeHandler);

          // Set timeout if specified and not 0
          if (timeout && timeout > 0) {
            timeoutId = setTimeout(() => {
              connector.events.off("statusChange", statusChangeHandler);
              reject(
                new Error(
                  `Timeout waiting for status: ${targetStatus} (${timeout}s)`,
                ),
              );
            }, timeout * 1000);
          }
        });
      },
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
      log: (message, level = "info") => {
        // Use ChargePoint logger with SCENARIO log type
        switch (level) {
          case "debug":
            cp.logger.debug(message, ocpp.LogType.SCENARIO);
            break;
          case "info":
            cp.logger.info(message, ocpp.LogType.SCENARIO);
            break;
          case "warn":
            cp.logger.warn(message, ocpp.LogType.SCENARIO);
            break;
          case "error":
            cp.logger.error(message, ocpp.LogType.SCENARIO);
            break;
        }
      },
    };

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
  }, [scenarios]);

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

  return (
    <div
      className="panel cursor-pointer hover:shadow-lg transition-shadow"
      onClick={handleOpenScenarioEditor}
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
            {connectorStatus === ocpp.OCPPStatus.Charging && (
              <div className="absolute -top-1 -right-1 text-xl animate-pulse">
                ⚡
              </div>
            )}
          </div>

          {/* Status and Meter Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold text-primary">
                <ConnectorStatus status={connectorStatus} />
              </span>
              {transactionId && (
                <span className="text-xs text-muted font-mono">
                  TX:{transactionId}
                </span>
              )}
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
              {liveSoc !== null && (
                <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${getBatteryFillColor()} transition-all duration-300 ease-out`}
                    style={{ width: `${chargingLevel}%` }}
                  ></div>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 dark:text-gray-400">
                  <ConnectorAvailability availability={availability} />
                </span>
                {liveSoc !== null && (
                  <span className="text-gray-600 dark:text-gray-400">
                    {(liveMeterValue / 1000).toFixed(2)} kWh charged
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="text-center py-2 border-t border-gray-200 dark:border-gray-700">
        <span className="inline-flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300 font-medium">
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
                    scenario={scenario}
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
                        State Transition Diagram (OCPP 1.6J)
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
