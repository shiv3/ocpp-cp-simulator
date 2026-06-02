import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";
import type { LogEntry } from "../../cp/shared/Logger";

export interface ConnectorSnapshot {
  id: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  meterValue: number;
  transactionId: number | null;
  soc: number | null;
  mode: ScenarioMode;
  autoResetToAvailable: boolean;
  autoMeterValueConfig: AutoMeterValueConfig | null;
  evSettings: EVSettings | null;
  chargingProfile: ActiveChargingProfile | null;
  chargingProfiles: ReadonlyArray<ActiveChargingProfile>;
  transactionStartTime: Date | null;
  transactionTagId: string | null;
  transactionBatteryCapacityKwh: number | null;
}

export interface ChargePointSnapshot {
  id: string;
  status: OCPPStatus;
  error: string;
  connectors: ConnectorSnapshot[];
  /** Current heartbeat configuration (§4.6). `intervalSeconds=0` = not yet
   *  configured / disabled by ChangeConfiguration. `lastSentAt` is an ISO
   *  string for remote-mode JSON safety; null if no Heartbeat.req has been
   *  sent since the daemon started. */
  heartbeat?: { intervalSeconds: number; lastSentAt: string | null };
  /** Init the CP was constructed with — exposed in Remote mode so the web
   *  console can prefill the "Edit CP" modal. Undefined in Local mode
   *  (the browser already owns the config) and on older daemons that
   *  don't ship this field. */
  config?: {
    wsUrl: string;
    connectors: number;
    vendor: string;
    model: string;
    basicAuth: { username: string; password: string } | null;
    bootNotification: {
      firmwareVersion?: string;
      chargePointSerialNumber?: string;
      chargeBoxSerialNumber?: string;
      meterSerialNumber?: string;
      meterType?: string;
      iccid?: string;
      imsi?: string;
    } | null;
  };
}

export interface CreateChargePointParams {
  cpId: string;
  wsUrl: string;
  connectors?: number;
  vendor?: string;
  model?: string;
  basicAuth?: { username: string; password: string } | null;
  bootNotification?: {
    firmwareVersion?: string;
    chargePointSerialNumber?: string;
    chargeBoxSerialNumber?: string;
    meterSerialNumber?: string;
    meterType?: string;
    iccid?: string;
    imsi?: string;
  };
  autoConnect?: boolean;
}

export type ChargePointEvent =
  | { type: "status"; status: OCPPStatus }
  | { type: "error"; error: string }
  | {
      type: "connector-status";
      connectorId: number;
      status: OCPPStatus;
      previousStatus: OCPPStatus;
    }
  | {
      type: "connector-availability";
      connectorId: number;
      availability: OCPPAvailability;
    }
  | {
      type: "connector-transaction";
      connectorId: number;
      transactionId: number | null;
    }
  | { type: "connector-meter"; connectorId: number; meterValue: number }
  | { type: "connector-soc"; connectorId: number; soc: number | null }
  | {
      type: "connector-auto-meter";
      connectorId: number;
      config: AutoMeterValueConfig;
    }
  | { type: "connector-mode"; connectorId: number; mode: ScenarioMode }
  | {
      type: "connector-auto-reset-to-available";
      connectorId: number;
      enabled: boolean;
    }
  | {
      type: "connector-ev-settings";
      connectorId: number;
      settings: EVSettings;
    }
  | {
      type: "connector-charging-profile";
      connectorId: number;
      profile: ActiveChargingProfile | null;
    }
  | {
      type: "connector-charging-profiles";
      connectorId: number;
      profiles: ActiveChargingProfile[];
    }
  | {
      type: "scenario-started";
      connectorId: number;
      scenarioId: string;
    }
  | {
      type: "scenario-completed";
      connectorId: number;
      scenarioId: string;
    }
  | {
      type: "scenario-error";
      connectorId: number;
      scenarioId: string;
      error: string;
    }
  | {
      type: "scenario-node-execute";
      connectorId: number;
      scenarioId: string;
      nodeId: string;
    }
  | {
      /** §4.6 Heartbeat state. `intervalSeconds=0` means the CSMS has not
       *  configured a heartbeat (or set it to 0 to disable). `lastSentAt` is
       *  an ISO string so the same shape works over the remote-mode events
       *  WebSocket. */
      type: "heartbeat";
      intervalSeconds: number;
      lastSentAt: string | null;
    }
  | { type: "state-history-entry"; entry: StateHistoryEntry }
  | { type: "connector-removed"; connectorId: number }
  | { type: "log"; entry: LogEntry }
  | { type: "connected" }
  | { type: "disconnected"; code: number; reason: string };

export interface ScenarioListItem {
  scenarioId: string;
  name: string;
  active: boolean;
}

/** Shape of one persisted log row as returned by `listStoredLogs` and
 *  emitted by the daemon's JSON Lines log format. Kept flat so the file
 *  is grep / jq-friendly. */
export interface StoredLogEntry {
  /** ISO-8601 timestamp in UTC. */
  timestamp: string;
  /** "DEBUG" | "INFO" | "WARN" | "ERROR" — string form of LogLevel for
   *  stability across enum-renumbering. */
  level: string;
  /** LogType enum value (e.g., "WebSocket", "OCPP", "Scenario"). */
  type: string;
  /** Charge point id this entry belongs to. */
  cpId: string;
  /** Human-readable log line. */
  message: string;
}

export interface ScenarioTemplateInfo {
  id: string;
  name: string;
  description: string;
}

export interface ChargePointSummary {
  cpId: string;
  status: OCPPStatus | string;
  connectors: number;
}

// Forward declaration to avoid circular dep with the domain class.
// LocalChargePointService returns a real ChargePoint here;
// RemoteChargePointService returns null because the domain object lives on
// the server, not in the browser. Use this only for opt-in local-only
// features (scenario manager wiring, etc.).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LocalChargePointHandle = any;

export interface ChargePointService {
  // Discovery
  listChargePoints(): Promise<ChargePointSnapshot[]>;
  getChargePoint(id: string): Promise<ChargePointSnapshot | null>;
  /** Returns the in-process domain ChargePoint when available (local mode). */
  getLocalChargePoint?(id: string): LocalChargePointHandle | null;

  // Registry (mainly relevant for remote mode; local always returns false / no-ops cleanly)
  createChargePoint?(params: CreateChargePointParams): Promise<void>;
  /** Replace the configuration of an existing CP. Remote only — the daemon
   *  tears down the existing WebSocket, persists the new row in-place
   *  (preserving any loaded scenarios), and re-instantiates the CP. The
   *  local-mode store edits its config directly without needing this
   *  method, so the interface keeps it optional. */
  updateChargePoint?(params: CreateChargePointParams): Promise<void>;
  removeChargePoint?(id: string): Promise<void>;
  ping?(): Promise<{ ok: boolean; cps: number }>;

  /** Wipe every simulator-owned table in the backing SQLite store
   *  (scenarios, connector settings, charging profiles, configuration
   *  overrides, pending messages, logs, …). Schema is preserved.
   *
   *  In local mode this clears the browser sql.js DB. In remote mode it
   *  hits `POST /v1/state/reset` on the daemon. Callers should reload
   *  the UI afterwards to drop in-memory caches. */
  resetAllState?(): Promise<void>;

  /** Delete all persisted log rows for the given CP from the SQLite store.
   *  Does NOT touch the in-memory log buffer the UI is reading from — the
   *  caller is expected to clear that separately so the user keeps control
   *  over the screen-side state. */
  clearStoredLogs?(cpId: string): Promise<void>;

  /** Return every persisted log row for the given CP, oldest-first. Used
   *  by the Download Logs button — the returned shape is what the JSONL
   *  file ends up containing, one JSON object per line. */
  listStoredLogs?(cpId: string): Promise<StoredLogEntry[]>;

  // Lifecycle
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  sendHeartbeat(id: string): Promise<void>;
  startHeartbeat(id: string, intervalSeconds: number): Promise<void>;
  stopHeartbeat(id: string): Promise<void>;
  authorize(id: string, tagId: string): Promise<void>;

  // Connector operations
  startTransaction(
    id: string,
    connectorId: number,
    tagId: string,
  ): Promise<void>;
  stopTransaction(id: string, connectorId: number): Promise<void>;
  sendStatusNotification(
    id: string,
    connectorId: number,
    status: OCPPStatus,
    opts?: {
      errorCode?: string;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
    },
  ): Promise<void>;
  setMeterValue(id: string, connectorId: number, value: number): Promise<void>;
  sendMeterValue(id: string, connectorId: number): Promise<void>;
  removeConnector(id: string, connectorId: number): Promise<void>;

  // Connector settings
  setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettings,
  ): Promise<void>;
  setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void>;
  setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void>;
  /**
   * Override the connector's current State-of-Charge percentage. Pass null
   * to clear the SoC (so subsequent meter values don't carry the field).
   */
  setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void>;
  /**
   * Enable/disable SoC ↔ Meter auto-sync for a connector. When on, any
   * meter-value update (UI, scenario auto-meter, etc.) derives a SoC value
   * from EV-settings (initialSoc + delivered_kWh / capacity_kWh × 100) and
   * pushes it into the connector. UI persists the preference globally via
   * `connectorSettingsRepository.saveSocMeterSync` (SQLite `kv` table);
   * pushing it down the service here makes it stick on every connector
   * instance.
   */
  setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>>;

  // State history
  getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]>;

  // Scenarios
  getScenarioTemplates(): Promise<ScenarioTemplateInfo[]>;
  loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
  ): Promise<{ scenarioId: string }>;
  loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }>;
  listScenarios(id: string, connectorId: number): Promise<ScenarioListItem[]>;
  runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void>;
  stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force?: boolean,
  ): Promise<void>;
  stopAllScenarios(id: string, connectorId: number): Promise<void>;
  getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null>;
  /**
   * Returns the loaded scenario definition (or null) for a given connector
   * + scenarioId. Lets the browser inspect scenarios that the server
   * loaded out-of-band (e.g. via `--scenario-template-file`).
   */
  getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null>;

  // Event subscription
  subscribe(id: string, handler: (event: ChargePointEvent) => void): () => void;
}
