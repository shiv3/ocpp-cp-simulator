import type { EvConnectionState } from "@ocpp-cp-simulator/core/cp/domain/connector/EvConnection";
import type { TransportConfigWire } from "@ocpp-cp-simulator/contracts/transportConfig";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type {
  ScenarioExecutionMode,
  ScenarioExecutionState,
  ScenarioMode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { StateHistoryEntry } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { LogEntry } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { TimelineEntry } from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type { ChargingSession } from "@ocpp-cp-simulator/core/cp/domain/session/ChargingSession";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import type { TransportConfig } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/TransportConfig";
import type { UrlDistribution } from "@ocpp-cp-simulator/core/cp/domain/transport/UrlDistribution";
import type { IdTagDistribution } from "@ocpp-cp-simulator/core/cp/domain/auth/IdTagPool";
import type { Labels } from "@ocpp-cp-simulator/contracts/labels";
import type { ModemConfig } from "@ocpp-cp-simulator/core/cp/domain/modem/CellularModem";
import type { ModemWire } from "@ocpp-cp-simulator/contracts/events";
import type { ReadonlyChargerCapabilities } from "@ocpp-cp-simulator/contracts/chargerCapabilities";

export interface ConnectorSnapshot {
  id: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  /** Energy register, in Wh. */
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
  /** The EV and cable state (#453). Absent from a daemon that predates it. */
  evConnection?: EvConnectionState;
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
  /** Network simulation summary: { enabled, manualRuleIds } when a config has
   *  been applied, null for SOAP CPs or when no config has been applied. */
  networkSim?: { enabled: boolean; manualRuleIds: string[] } | null;
  /** Cellular modem and SIM, identifiers masked (#928); absent when the
   *  station has no modem model. */
  modem?: ModemWire;
  /** Init the CP was constructed with — exposed in Remote mode so the web
   *  console can prefill the "Edit CP" modal. Undefined in Local mode
   *  (the browser already owns the config) and on older daemons that
   *  don't ship this field. */
  config?: {
    wsUrl: string;
    centralSystemUrl?: string;
    soapCallbackUrl?: string;
    /** The daemon derived `soapCallbackUrl` from its SOAP public base
     *  (`--soap-public-base-url` / `--soap-tunnel`); it is not stored with
     *  the charge point and follows the base (#183). */
    soapCallbackUrlDerived?: boolean;
    soapPath?: string;
    ocppVersion?: string;
    connectors: number;
    vendor: string;
    model: string;
    basicAuth: { username: string; password: string } | null;
    securityProfile?: OcppSecurityProfile;
    cpoName?: string;
    /** #347: periodic samples ride TransactionEvent(Updated) on OCPP 2.x. */
    txUpdatedMeterValues?: boolean;
    /** #593: OCPP 1.6J inbound CALL validation mode. */
    inboundValidation?: "off" | "warn" | "enforce";
    /** #595: OCPP 1.6 ReserveNow authorizes the idTag first. */
    reservationAuthorizeIdTag?: boolean;
    /** #618: static capability profile. */
    capabilityProfile?: {
      disabledActions?: readonly string[];
      triggerMessageTargets?: readonly string[];
      disabledActionErrorCode?: "NotImplemented" | "NotSupported";
      statusTransitions?: "warn" | "enforce";
    };
    /** #609 / #611: reconnect policy and WebSocket client options; the
     *  proxy URL's credentials are removed. */
    transport?: TransportConfigWire;
    /** What the charger hardware delivers per connector (#327). */
    chargerCapabilities?: ReadonlyChargerCapabilities;
    tlsCaPath?: string;
    tlsCertPath?: string;
    tlsKeyPath?: string;
    bootNotification: {
      firmwareVersion?: string;
      chargePointSerialNumber?: string;
      chargeBoxSerialNumber?: string;
      meterSerialNumber?: string;
      meterType?: string;
      iccid?: string;
      imsi?: string;
    } | null;
    /** Operator labels (#446); absent when the charge point has none. */
    labels?: Labels;
    /** Ids of the loaded behaviors it runs; absent: every loaded behavior. */
    behaviors?: readonly string[];
    /** Params the selection sets on behaviors (#654), by behavior id. */
    behaviorParams?: BehaviorParamsByIdWire;
  };
}

export interface CreateChargePointParams {
  cpId: string;
  wsUrl: string;
  /**
   * Every supervision URL, when more than one was given. OCPP-J only; the
   * transport resolves one of them per connection attempt while `wsUrl` stays
   * the single string everything else reports and persists.
   */
  supervisionUrls?: readonly string[];
  urlDistribution?: UrlDistribution;
  /** Transport settings (#609): reconnect policy and BootNotification retry
   *  limit. Omitted fields keep the built-in behaviour. */
  transport?: TransportConfig;
  /**
   * Resolved idTags (#299). Declared here because the facade is where the
   * previous pool feature was silently dropped: `parseCreateBody` produced the
   * list, `toInitOptions` did not copy it, and the create reported success
   * with no pool at all.
   */
  idTags?: readonly string[];
  /** Where `idTags` was read from, when it came from `idTagPool.file` (#314).
   *  Declared here for the same reason `idTags` is: the facade is where a
   *  create parameter goes to be silently dropped. */
  idTagFile?: string;
  idTagDistribution?: IdTagDistribution;
  centralSystemUrl?: string;
  soapCallbackUrl?: string;
  soapPath?: string;
  ocppVersion?: string;
  connectors?: number;
  vendor?: string;
  model?: string;
  basicAuth?: { username: string; password?: string } | null;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  /** #347: periodic samples ride TransactionEvent(Updated) on OCPP 2.x.
   *  Omitted on an update keeps the current value. */
  txUpdatedMeterValues?: boolean;
  /** #593: OCPP 1.6J inbound CALL validation (off | warn | enforce).
   *  Omitted on an update keeps the current value. */
  inboundValidation?: "off" | "warn" | "enforce";
  /** #595: OCPP 1.6 ReserveNow authorizes the idTag first.
   *  Omitted on an update keeps the current value. */
  reservationAuthorizeIdTag?: boolean;
  /** #618: static capability profile (omitted on an update keeps it). */
  capabilityProfile?: {
    disabledActions?: readonly string[];
    triggerMessageTargets?: readonly string[];
    disabledActionErrorCode?: "NotImplemented" | "NotSupported";
    statusTransitions?: "warn" | "enforce";
  };
  /** Charger-side delivery caps per connector (#327); omitted on an update
   *  keeps the current ones. */
  chargerCapabilities?: ReadonlyChargerCapabilities;
  /** Cellular modem and SIM (#928): initial state; persisted state wins, and
   *  omitted on an update keeps the current model. */
  modem?: ModemConfig;
  tls?: OcppTlsOptions;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
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
  /** Operator labels (#446). On update, omitted keeps the current ones. */
  labels?: Labels;
  /** Ids of the loaded behaviors to run; absent: all (on update: keep the current). */
  behaviors?: readonly string[];
  /** Params for the behaviors, by id (#654); JSON only. On update, omitted keeps the current ones. */
  behaviorParams?: BehaviorParamsByIdWire;
}

/** Behavior id to the JSON object of its params. */
export type BehaviorParamsByIdWire = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

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
      /** Runtime run id (daemon only — local mode mints none). */
      runId?: string;
    }
  | {
      type: "scenario-completed";
      connectorId: number;
      scenarioId: string;
      /** Runtime run id (daemon only — local mode mints none). */
      runId?: string;
    }
  | {
      type: "scenario-error";
      connectorId: number;
      scenarioId: string;
      /** Runtime run id (daemon only — local mode mints none). */
      runId?: string;
      error: string;
    }
  | {
      type: "scenario-node-execute";
      connectorId: number;
      scenarioId: string;
      /** Runtime run id (daemon only — local mode mints none). */
      runId?: string;
      nodeId: string;
    }
  | {
      /** #388: a finished run's report was added to the daemon's run
       *  history; re-list runs. Daemon only. */
      type: "scenario-run-recorded";
      connectorId: number;
      scenarioId: string;
      runId: string;
    }
  | {
      /** #240: an operator extended, retried or continued the parked wait;
       *  re-read the scenario status for the new deadline. */
      type: "scenario-wait-changed";
      connectorId: number;
      scenarioId: string;
      /** Runtime run id (daemon only — local mode mints none). */
      runId?: string;
      nodeId: string;
      kind: "extend" | "retry" | "continue";
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
  /** #448: an entry was added to the charge point's operational timeline. */
  | { type: "timeline-entry"; entry: TimelineEntry }
  /** #447: a charging session was opened, updated or closed. */
  | { type: "charging-session"; session: ChargingSession }
  | { type: "disconnected"; code: number; reason: string };

export interface ScenarioListItem {
  scenarioId: string;
  name: string;
  active: boolean;
  /**
   * Execution state, from the same source as `scenario_status`. Null for a
   * scenario that has never run.
   *
   * The daemon also reports the TERMINAL state of a finished run here (that is
   * what makes a listing useful for "which of these have run, and how did they
   * end?"). Local/browser mode only tracks live executors, so it reports a
   * state while a run is in flight and null once it ends.
   */
  state?: ScenarioExecutionState | null;
  /** Execution mode of the run `state` describes; null when there is none. */
  mode?: ScenarioExecutionMode | null;
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

export interface ScenarioRunOptions {
  connectorId?: number;
  evSettings?: Partial<EVSettings>;
  strict?: boolean;
  /**
   * `run_scenario_template` only (#352). `true` loads the template's instance
   * with `enabled: false` before the explicit start, so the connect-triggered
   * auto-start walker never re-arms it: the run this call makes is its only
   * one. Default (`false` / absent): the instance stays enabled and re-arms on
   * every reconnect, as every loaded connect-triggered scenario does (#253).
   */
  once?: boolean;
  /**
   * Handed the exact text a scenario file was read from, for `--watch`'s reload
   * baseline (#314).
   *
   * A callback rather than a field on the result, deliberately. Returning it
   * meant every dispatcher had to remember to strip it: the socket.io one did,
   * and the standalone JSON one printed the whole scenario file to stdout while
   * breaking the documented `{ scenarioId }` result shape. A value that is never
   * part of the result cannot be forgotten by a second transport.
   */
  onSourceText?: (text: string) => void;
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
