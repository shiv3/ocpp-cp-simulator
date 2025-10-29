import React, { useState, useEffect, useCallback } from "react";
import { ChargePoint as OCPPChargePoint } from "../cp/ChargePoint";
import Connector from "./Connector.tsx";
import Logger from "./Logger.tsx";
import * as ocpp from "../cp/OcppTypes";
import { LogEntry } from "../cp/Logger";

interface ChargePointProps {
  cp: OCPPChargePoint;
  TagID: string;
}

const ChargePoint: React.FC<ChargePointProps> = (props) => {
  const [cp, setCp] = useState<OCPPChargePoint | null>(null);
  const [cpStatus, setCpStatus] = useState<string>(ocpp.OCPPStatus.Unavailable);
  const [cpError, setCpError] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connectorCount, setConnectorCount] = useState<number>(0);

  const clearLogs = useCallback(() => {
    setLogs([]);
    // Clear the logger in the ChargePoint
    if (cp) {
      cp.logger.clearLogs();
    }
  }, [cp]);

  useEffect(() => {
    console.log("ChargePointProps", props);
    setCp(props.cp);
    setConnectorCount(props.cp.connectorNumber);

    // Subscribe to events using EventEmitter
    const unsubStatus = props.cp.events.on("statusChange", (data) => {
      setCpStatus(data.status);
    });

    const unsubError = props.cp.events.on("error", (data) => {
      setCpError(data.error);
    });

    const unsubConnectorRemoved = props.cp.events.on("connectorRemoved", () => {
      // Update connector count to trigger re-render
      setConnectorCount(props.cp.connectorNumber);
    });

    // Set up logging callback (still uses callback for Logger compatibility)
    const logMsg = (msg: string) => {
      console.log(msg);
      const logEntry = parseFormattedLog(msg);
      setLogs((prevLogs) => [...prevLogs, logEntry]);
    };
    props.cp.loggingCallback = logMsg;

    // Cleanup function to prevent memory leaks
    return () => {
      unsubStatus();
      unsubError();
      unsubConnectorRemoved();
      props.cp.loggingCallback = () => {};
    };
  }, [props]);

  return (
    <div className="card px-4 py-3">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        <div className="lg:col-span-1">
          <CPStatus status={cpStatus} />
        </div>
        <div className="lg:col-span-3">
          <SettingsView {...props} />
        </div>
      </div>

      <div className="mt-3">
        <ChargePointControls cp={cp} cpStatus={cpStatus} cpError={cpError} tagID={props.TagID} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
        {cp?.connectors &&
          Array.from(cp.connectors.keys()).map((connectorId) => (
            <Connector key={connectorId} id={connectorId} cp={cp} idTag={props.TagID} />
          ))}
      </div>

      <Logger logs={logs} onClear={clearLogs} />
    </div>
  );
};

const CPStatus: React.FC<{ status: string }> = ({ status }) => {
  const statusColor = (s: string) => {
    switch (s) {
      case ocpp.OCPPStatus.Unavailable:
        return "status-unavailable";
      case ocpp.OCPPStatus.Available:
        return "status-available";
      case ocpp.OCPPStatus.Charging:
        return "status-charging";
      default:
        return "status-error";
    }
  };
  return (
    <div className="panel-border mb-2">
      <label className="block text-sm font-semibold text-primary">CP Status</label>
      <p className="text-xl font-bold text-center">
        <span className={statusColor(status)}>{status}</span>
      </p>
    </div>
  );
};

interface AuthViewProps {
  cp: OCPPChargePoint | null;
  cpStatus: string;
  tagID: string;
}

interface ChargePointControlsProps {
  cp: OCPPChargePoint | null;
  cpStatus: string;
  cpError: string;
  tagID: string;
}

const ChargePointControls: React.FC<ChargePointControlsProps> = ({
  cp,
  cpStatus,
  cpError,
  tagID,
}) => {
  const [isHeartbeatEnabled, setIsHeartbeatEnabled] = useState<boolean>(false);

  const handleConnect = () => {
    if (cp) {
      cp.connect();
    }
  };

  const handleDisconnect = () => {
    if (cp) {
      cp.disconnect();
    }
  };
  const handleHeartbeat = () => {
    if (cp) {
      cp.sendHeartbeat();
    }
  };

  const handleHeartbeatInterval = (isEnalbe: boolean) => {
    setIsHeartbeatEnabled(isEnalbe);
    if (cp) {
      if (isEnalbe) {
        cp.startHeartbeat(10);
      } else {
        cp.stopHeartbeat();
      }
    }
  };

  const handleAuthorize = () => {
    if (cp) {
      cp.authorize(tagID);
    }
  };

  return (
    <div className="panel p-3">
      {cpError !== "" && (
        <div className="btn-danger mb-2 text-sm p-2">
          Error: {cpError}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleConnect}
          className="btn-primary"
          disabled={cpStatus !== ocpp.OCPPStatus.Unavailable}
        >
          Connect
        </button>
        <button
          onClick={handleDisconnect}
          className="btn-danger"
          disabled={cpStatus === ocpp.OCPPStatus.Unavailable}
        >
          Disconnect
        </button>
        <button
          onClick={handleHeartbeat}
          className="btn-info"
          disabled={cpStatus === ocpp.OCPPStatus.Unavailable}
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
          disabled={cpStatus !== ocpp.OCPPStatus.Available}
        >
          Authorize
        </button>
      </div>
    </div>
  );
};

const SettingsView: React.FC<ChargePointProps> = (props) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">ID:</span>
            <span className="font-semibold text-primary">{props.cp.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">Connectors:</span>
            <span className="text-secondary">{props.cp.connectorNumber}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">Tag:</span>
            <span className="font-mono text-secondary text-xs">{props.TagID}</span>
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
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted text-xs block">WebSocket URL</span>
              <span className="text-secondary text-xs font-mono break-all">{props.cp.wsUrl}</span>
            </div>
            <div>
              <span className="text-muted text-xs block">OCPP Version</span>
              <span className="text-secondary">1.6J</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Helper function to parse formatted log messages back into LogEntry objects
 * Format: [timestamp] [level] [type] message
 */
function parseFormattedLog(formattedMessage: string): LogEntry {
  // Match the format: [timestamp] [level] [type] message
  const match = formattedMessage.match(
    /\[([\d-T:.Z]+)\] \[(\w+)\] \[(\w+)\] (.*)/,
  );

  if (match) {
    const [, timestamp, level, type, message] = match;
    return {
      timestamp: new Date(timestamp),
      level: (ocpp.LogLevel as Record<string, number>)[level] ?? ocpp.LogLevel.INFO,
      type: type as ocpp.LogType,
      message,
    };
  }

  // Fallback if parsing fails
  return {
    timestamp: new Date(),
    level: ocpp.LogLevel.INFO,
    type: ocpp.LogType.GENERAL,
    message: formattedMessage,
  };
}

export default ChargePoint;
