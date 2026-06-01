import React, { useCallback, useEffect, useRef, useState } from "react";
import Connector from "./Connector.tsx";
import { ConnectorSidePanel } from "./ConnectorSidePanel.tsx";
import { LogViewer } from "./ui/log-viewer.tsx";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
} from "../cp/domain/types/OcppTypes";
import { useChargePointView } from "../data/hooks/useChargePointView";
import { useDataContext } from "../data/providers/DataProvider";

interface ChargePointProps {
  cpId: string;
  TagID: string;
}

// Panel width constants (in vw)
const PANEL_DEFAULT_WIDTH = 50; // 50vw default — keeps the home tab list
// readable behind the panel. Users can drag the left edge of the panel
// wider when they want more room for the scenario canvas.
const PANEL_COLLAPSED_WIDTH_PX = 60; // px for collapsed

const ChargePoint: React.FC<ChargePointProps> = ({ cpId, TagID }) => {
  const {
    status: cpStatus,
    error: cpError,
    connectors,
    heartbeat,
    logs,
    clearLogs,
  } = useChargePointView(cpId);
  const connectorIds = Array.from(connectors.keys()).sort((a, b) => a - b);

  // Side panel state
  const [selectedConnector, setSelectedConnector] = useState<number | null>(
    null,
  );
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [panelWidthVw, setPanelWidthVw] = useState(PANEL_DEFAULT_WIDTH);
  const [isPanelFullscreen, setIsPanelFullscreen] = useState(false);
  const [initialPanelTab, setInitialPanelTab] = useState<
    "details" | "scenario" | "stateTransition"
  >("details");
  // Bumped each time we want to force the panel back onto `initialPanelTab`
  // even if it's already open on a different tab.
  const [tabResetNonce, setTabResetNonce] = useState(0);

  const handleClearLogs = useCallback(() => {
    clearLogs();
  }, [clearLogs]);

  const handleConnectorSelect = useCallback((connectorId: number) => {
    // Toggle: clicking the already-selected connector closes the panel.
    // Clicking a different connector switches to it and (re-)opens the panel.
    setSelectedConnector((current) =>
      current === connectorId ? null : connectorId,
    );
    setInitialPanelTab("details");
    setTabResetNonce((n) => n + 1);
    setIsPanelCollapsed(false);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedConnector(null);
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setIsPanelCollapsed((prev) => {
      const next = !prev;
      // Collapsing while fullscreen would leave the panel covering the whole
      // viewport with only a mini-strip of content (collapsed mode renders a
      // tiny vertical bar), so step out of fullscreen first. Mirrors the
      // un-collapse done by handleToggleFullscreen on enter.
      if (next) setIsPanelFullscreen(false);
      return next;
    });
  }, []);

  const handleWidthChange = useCallback((newWidth: number) => {
    setPanelWidthVw(newWidth);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setIsPanelFullscreen((prev) => !prev);
    setIsPanelCollapsed(false);
  }, []);

  // Calculate margin for main content
  const mainContentMargin = selectedConnector
    ? isPanelFullscreen
      ? "100vw"
      : isPanelCollapsed
        ? `${PANEL_COLLAPSED_WIDTH_PX}px`
        : `${panelWidthVw}vw`
    : "0";

  return (
    <div className="relative">
      {/* Main Content Area */}
      <div
        className="transition-all duration-300 ease-in-out"
        style={{ marginRight: mainContentMargin }}
      >
        <div className="card px-4 py-3">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <div className="lg:col-span-1">
              <CPStatus status={cpStatus} />
            </div>
            <div className="lg:col-span-3">
              <SettingsView
                cpId={cpId}
                connectorCount={connectorIds.length}
                TagID={TagID}
              />
            </div>
          </div>

          <div className="mt-3">
            <ChargePointControls
              chargePointId={cpId}
              cpStatus={cpStatus}
              cpError={cpError}
              tagID={TagID}
              heartbeat={heartbeat}
            />
          </div>

          <ConnectorGrid
            connectorIds={connectorIds}
            cpId={cpId}
            TagID={TagID}
            selectedConnector={selectedConnector}
            onConnectorSelect={handleConnectorSelect}
          />

          <div className="mt-4">
            <LogViewer
              logs={logs}
              onClear={handleClearLogs}
              maxHeight="500px"
            />
          </div>
        </div>
      </div>

      {/* Fixed Side Panel */}
      {selectedConnector !== null && (
        <div
          className="fixed right-0 top-0 bottom-0 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-xl z-50 transition-all duration-300 ease-in-out"
          style={{
            width: isPanelFullscreen
              ? "100vw"
              : isPanelCollapsed
                ? `${PANEL_COLLAPSED_WIDTH_PX}px`
                : `${panelWidthVw}vw`,
          }}
        >
          <ConnectorSidePanel
            cpId={cpId}
            connectorId={selectedConnector}
            idTag={TagID}
            onClose={handleClosePanel}
            isCollapsed={isPanelCollapsed}
            onToggleCollapse={handleToggleCollapse}
            isFullscreen={isPanelFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            panelWidth={panelWidthVw}
            onWidthChange={handleWidthChange}
            initialTab={initialPanelTab}
            tabResetNonce={tabResetNonce}
          />
        </div>
      )}
    </div>
  );
};

// Container-width-based grid for the connector cards. The fixed
// `xl:grid-cols-4` we had before keyed off the viewport width, which
// stayed wide even when the side panel ate half the screen — so the
// cards squeezed into tiny columns. ResizeObserver picks the column
// count from the actual width of this wrapper, so the grid reflows as
// the panel opens/closes.
interface ConnectorGridProps {
  connectorIds: number[];
  cpId: string;
  TagID: string;
  selectedConnector: number | null;
  onConnectorSelect: (connectorId: number) => void;
}

const COLUMN_CLASS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

const ConnectorGrid: React.FC<ConnectorGridProps> = ({
  connectorIds,
  cpId,
  TagID,
  selectedConnector,
  onConnectorSelect,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      // Breakpoints chosen so a card stays >= ~220px before it wraps.
      const next = w < 480 ? 1 : w < 720 ? 2 : w < 1024 ? 3 : 4;
      setCols(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className={`grid ${COLUMN_CLASS[cols]} gap-4 mt-3`}>
      {connectorIds.map((connectorId) => (
        <Connector
          key={connectorId}
          id={connectorId}
          cpId={cpId}
          idTag={TagID}
          isSelected={selectedConnector === connectorId}
          onSelect={() => onConnectorSelect(connectorId)}
        />
      ))}
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

/**
 * Inline read-only display of the heartbeat configuration. The interval is
 * owned by the CSMS (BootNotification.conf.interval / ChangeConfiguration);
 * the simulator only echoes whatever the CSMS has set. Ticks every second
 * so the "last sent" string stays fresh.
 */
const HeartbeatStatusChip: React.FC<{
  heartbeat: { intervalSeconds: number; lastSentAt: Date | null };
  isConnected: boolean;
}> = ({ heartbeat, isConnected }) => {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!isConnected) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400 px-2 py-1 rounded bg-gray-100 dark:bg-gray-800">
        Heartbeat: not connected
      </span>
    );
  }

  const interval =
    heartbeat.intervalSeconds > 0
      ? `${heartbeat.intervalSeconds}s`
      : "not configured";

  const lastSent = heartbeat.lastSentAt
    ? `${Math.max(
        0,
        Math.floor((Date.now() - heartbeat.lastSentAt.getTime()) / 1000),
      )}s ago`
    : "never";

  return (
    <span
      className="text-xs text-gray-700 dark:text-gray-300 px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 font-mono"
      title="Heartbeat interval is set by BootNotification.conf.interval and updated by ChangeConfiguration HeartbeatInterval (§4.6). Any outgoing CALL resets the idle timer."
    >
      Heartbeat: {interval} · last sent {lastSent}
    </span>
  );
};

interface ChargePointControlsProps {
  chargePointId: string | null;
  cpStatus: string;
  cpError: string;
  tagID: string;
  heartbeat: { intervalSeconds: number; lastSentAt: Date | null };
}

const ChargePointControls: React.FC<ChargePointControlsProps> = ({
  chargePointId,
  cpStatus,
  cpError,
  tagID,
  heartbeat,
}) => {
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

  const handleAuthorize = () => {
    if (!chargePointId) return;
    void chargePointService.authorize(chargePointId, tagID);
  };

  // Faulted requires picking a ChargePointErrorCode; other statuses ignore
  // the picker. We hold the selected errorCode here so the operator can pick
  // it before hitting Send.
  const [pendingFaultErrorCode, setPendingFaultErrorCode] =
    useState<string>("InternalError");

  const handleCPStatusChange = (status: OCPPStatus) => {
    if (!chargePointId) return;
    if (status === OCPPStatus.Faulted) {
      void chargePointService.sendStatusNotification(chargePointId, 0, status, {
        errorCode: pendingFaultErrorCode,
      });
    } else {
      void chargePointService.sendStatusNotification(chargePointId, 0, status);
    }
  };

  const isConnected = cpStatus !== OCPPStatus.Unavailable;

  return (
    <div className="panel p-3">
      {cpError !== "" && (
        <div className="btn-danger mb-2 text-sm p-2">Error: {cpError}</div>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={handleConnect}
          className="btn-primary"
          disabled={isConnected}
        >
          Connect
        </button>
        <button
          onClick={handleDisconnect}
          className="btn-danger"
          disabled={!isConnected}
        >
          Disconnect
        </button>
        <button
          onClick={handleHeartbeat}
          className="btn-info"
          disabled={!isConnected}
          title="Send a Heartbeat.req now (§4.6). The CSMS replies with currentTime."
        >
          Send Heartbeat
        </button>
        <HeartbeatStatusChip heartbeat={heartbeat} isConnected={isConnected} />
        <button
          onClick={handleAuthorize}
          className="btn-success"
          disabled={cpStatus !== OCPPStatus.Available}
        >
          Authorize
        </button>

        <div className="flex items-center gap-1 ml-2">
          <label className="text-xs text-muted whitespace-nowrap">
            CP Status:
          </label>
          <select
            className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-primary"
            disabled={!isConnected}
            value=""
            onChange={(e) => {
              if (e.target.value) {
                handleCPStatusChange(e.target.value as OCPPStatus);
              }
            }}
          >
            <option value="" disabled>
              Send...
            </option>
            <option value={OCPPStatus.Available}>Available</option>
            <option value={OCPPStatus.Unavailable}>Unavailable</option>
            <option value={OCPPStatus.Faulted}>Faulted</option>
          </select>
          {/* §7.6 errorCode picker — paired with the Faulted option of the
              status select. Selecting a code arms the next Send Faulted. */}
          <select
            className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-primary"
            value={pendingFaultErrorCode}
            onChange={(e) => setPendingFaultErrorCode(e.target.value)}
            title="errorCode used when Send → Faulted"
          >
            {ALL_CHARGE_POINT_ERROR_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};

interface SettingsViewProps {
  cpId: string;
  connectorCount: number;
  TagID: string;
}

const SettingsView: React.FC<SettingsViewProps> = ({
  cpId,
  connectorCount,
  TagID,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">ID:</span>
            <span className="font-semibold text-primary">{cpId}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">Connectors:</span>
            <span className="text-secondary">{connectorCount}</span>
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
