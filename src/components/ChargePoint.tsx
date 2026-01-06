import React, { useCallback, useState } from "react";
import { ChargePoint as OCPPChargePoint } from "../cp/domain/charge-point/ChargePoint";
import Connector from "./Connector.tsx";
import { LogViewer } from "./ui/log-viewer.tsx";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import { useChargePointView } from "../data/hooks/useChargePointView";
import { useDataContext } from "../data/providers/DataProvider";

interface ChargePointProps {
  cp: OCPPChargePoint;
  TagID: string;
}

const ChargePoint: React.FC<ChargePointProps> = ({ cp, TagID }) => {
  const {
    status: cpStatus,
    error: cpError,
    logs,
    clearLogs,
  } = useChargePointView(cp);
  const connectorIds = cp ? Array.from(cp.connectors.keys()) : [];

  const handleClearLogs = useCallback(() => {
    clearLogs();
  }, [clearLogs]);

  return (
    <div className="card px-4 py-3">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        <div className="lg:col-span-1">
          <CPStatus status={cpStatus} />
        </div>
        <div className="lg:col-span-3">
          <SettingsView cp={cp} TagID={TagID} />
        </div>
      </div>

      <div className="mt-3">
        <ChargePointControls
          chargePointId={cp?.id ?? null}
          cpStatus={cpStatus}
          cpError={cpError}
          tagID={TagID}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-3">
        {connectorIds.map((connectorId) => (
          <Connector key={connectorId} id={connectorId} cp={cp} idTag={TagID} />
        ))}
      </div>

      <div className="mt-4">
        <LogViewer logs={logs} onClear={handleClearLogs} maxHeight="500px" />
      </div>
    </div>
  );
};

const CPStatus: React.FC<{ status: string }> = ({ status }) => {
  const statusColor = (s: string) => {
    switch (s) {
      case OCPPStatus.Unavailable:
        return "status-unavailable";
      case OCPPStatus.Available:
        return "status-available";
      case OCPPStatus.Charging:
        return "status-charging";
      default:
        return "status-error";
    }
  };
  return (
    <div className="panel-border mb-2">
      <label className="block text-sm font-semibold text-primary">
        CP Status
      </label>
      <p className="text-xl font-bold text-center">
        <span className={statusColor(status)}>{status}</span>
      </p>
    </div>
  );
};

interface ChargePointControlsProps {
  chargePointId: string | null;
  cpStatus: string;
  cpError: string;
  tagID: string;
}

const ChargePointControls: React.FC<ChargePointControlsProps> = ({
  chargePointId,
  cpStatus,
  cpError,
  tagID,
}) => {
  const [isHeartbeatEnabled, setIsHeartbeatEnabled] = useState<boolean>(false);
  const { chargePointService } = useDataContext();

  const handleConnect = () => {
    if (!chargePointId) return;
    void chargePointService.connect(chargePointId);
  };

  const handleDisconnect = () => {
    if (!chargePointId) return;
    void chargePointService.disconnect(chargePointId);
  };
  const handleHeartbeat = () => {
    if (!chargePointId) return;
    void chargePointService.sendHeartbeat(chargePointId);
  };

  const handleHeartbeatInterval = (isEnable: boolean) => {
    setIsHeartbeatEnabled(isEnable);
    if (!chargePointId) return;
    if (isEnable) {
      void chargePointService.startHeartbeat(chargePointId, 10);
    } else {
      void chargePointService.stopHeartbeat(chargePointId);
    }
  };

  const handleAuthorize = () => {
    if (!chargePointId) return;
    void chargePointService.authorize(chargePointId, tagID);
  };

  return (
    <div className="panel p-3">
      {cpError !== "" && (
        <div className="btn-danger mb-2 text-sm p-2">Error: {cpError}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleConnect}
          className="btn-primary"
          disabled={cpStatus !== OCPPStatus.Unavailable}
        >
          Connect
        </button>
        <button
          onClick={handleDisconnect}
          className="btn-danger"
          disabled={cpStatus === OCPPStatus.Unavailable}
        >
          Disconnect
        </button>
        <button
          onClick={handleHeartbeat}
          className="btn-info"
          disabled={cpStatus === OCPPStatus.Unavailable}
        >
          Heartbeat
        </button>
        <button
          className={isHeartbeatEnabled ? "btn-danger" : "btn-success"}
          onClick={() => handleHeartbeatInterval(!isHeartbeatEnabled)}
        >
          {isHeartbeatEnabled ? "Disable" : "Enable"} Heartbeat
        </button>
        <button
          onClick={handleAuthorize}
          className="btn-success"
          disabled={cpStatus !== OCPPStatus.Available}
        >
          Authorize
        </button>
      </div>
    </div>
  );
};

const SettingsView: React.FC<ChargePointProps> = ({ cp, TagID }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">ID:</span>
            <span className="font-semibold text-primary">{cp.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">Connectors:</span>
            <span className="text-secondary">{cp.connectorNumber}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">Tag:</span>
            <span className="font-mono text-secondary text-xs">{TagID}</span>
          </div>
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
        >
          {isExpanded ? "Hide Details" : "Show Details"}
        </button>
      </div>

      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-xs text-gray-600 dark:text-gray-400 block mb-1">
                WebSocket URL
              </span>
              <span className="text-xs text-gray-900 dark:text-gray-100 font-mono break-all">
                {cp.wsUrl}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-600 dark:text-gray-400 block mb-1">
                OCPP Version
              </span>
              <span className="text-xs text-gray-900 dark:text-gray-100">
                1.6J
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChargePoint;
