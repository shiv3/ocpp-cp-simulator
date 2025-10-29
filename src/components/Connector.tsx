import React, { useState, useEffect, useRef } from "react";
import { ChargePoint } from "../cp/ChargePoint.ts";
import * as ocpp from "../cp/OcppTypes";
import { OCPPAvailability } from "../cp/OcppTypes";
import { AutoMeterValueConfig } from "../cp/types/MeterValueCurve";
import { ScenarioMode } from "../cp/types/ScenarioTypes";
import MeterValueCurveModal from "./MeterValueCurveModal.tsx";
import ScenarioEditor from "./scenario/ScenarioEditor.tsx";
import { HiCog } from "react-icons/hi";
import { saveConnectorAutoMeterConfig } from "../utils/connectorStorage";
import { Modal } from "flowbite-react";

interface ConnectorProps {
  id: number;
  cp: ChargePoint | null;
  idTag: string;
}

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
  const [panelWidth, setPanelWidth] = useState(80); // Default 80vw
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

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
          ⚙️ Click to open Scenario Editor
        </span>
      </div>

      {/* Scenario Editor Side Panel */}
      {isScenarioEditorOpen && cp && (
        <div className="fixed inset-0 z-[9999] flex justify-end">
          {/* Semi-transparent overlay on the left - clicking closes the editor */}
          <div
            className="flex-1 bg-black bg-opacity-20"
            onClick={() => setIsScenarioEditorOpen(false)}
          />

          {/* Side Panel */}
          <div
            className="bg-white dark:bg-gray-900 shadow-2xl overflow-hidden flex"
            style={{ width: `${panelWidth}vw` }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Resize Handle */}
            <div
              className={`w-1 bg-gray-300 dark:bg-gray-600 hover:bg-blue-500 dark:hover:bg-blue-400 cursor-col-resize flex-shrink-0 ${
                isResizing ? "bg-blue-500 dark:bg-blue-400" : ""
              }`}
              onMouseDown={handleResizeStart}
              style={{ cursor: "col-resize" }}
            >
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-0.5 h-8 bg-gray-400 dark:bg-gray-500"></div>
              </div>
            </div>

            {/* Panel Content */}
            <div className="flex-1 overflow-hidden">
              <ScenarioEditor
                chargePoint={cp}
                connectorId={connector_id}
                onClose={() => setIsScenarioEditorOpen(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

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

export default Connector;
