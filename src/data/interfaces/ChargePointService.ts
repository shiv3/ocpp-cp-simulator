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
  removeChargePoint?(id: string): Promise<void>;
  ping?(): Promise<{ ok: boolean; cps: number }>;

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
    mode?: import("../../cp/application/scenario/ScenarioTypes").ScenarioExecutionMode,
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

  // Event subscription
  subscribe(id: string, handler: (event: ChargePointEvent) => void): () => void;
}
