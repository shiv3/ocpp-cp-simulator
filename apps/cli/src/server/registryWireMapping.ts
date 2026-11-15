import type {
  ChargePointEvent,
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { redactTransport } from "@ocpp-cp-simulator/contracts/events";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ScenarioMode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { CLIEvent } from "../service";
import type { ChargePointStatus } from "../types";
import type { RegistryMembershipEvent } from "./CPRegistry";

export function toMembershipSnapshot(
  event: RegistryMembershipEvent,
): ChargePointSnapshot {
  return toChargePointSnapshot(event.service.getStatus());
}

export function toChargePointSnapshot(
  status: ChargePointStatus,
): ChargePointSnapshot {
  return {
    id: status.id,
    status: status.status as OCPPStatus,
    error: status.error,
    connectors: status.connectors.map(toConnectorSnapshot),
    heartbeat: status.heartbeat,
    networkSim: status.networkSim,
    ...(status.modem ? { modem: status.modem } : {}),
    config: status.config
      ? {
          wsUrl: status.config.wsUrl,
          centralSystemUrl: status.config.centralSystemUrl,
          soapCallbackUrl: status.config.soapCallbackUrl,
          soapCallbackUrlDerived: status.config.soapCallbackUrlDerived,
          soapPath: status.config.soapPath,
          ocppVersion: status.config.ocppVersion,
          connectors: status.config.connectors,
          vendor: status.config.vendor,
          model: status.config.model,
          basicAuth: status.config.basicAuth
            ? {
                username: status.config.basicAuth.username,
                password: status.config.basicAuth.password ?? "",
              }
            : null,
          securityProfile: status.config.securityProfile,
          cpoName: status.config.cpoName,
          txUpdatedMeterValues: status.config.txUpdatedMeterValues,
          inboundValidation: status.config.inboundValidation,
          reservationAuthorizeIdTag: status.config.reservationAuthorizeIdTag,
          capabilityProfile: status.config.capabilityProfile,
          ...(status.config.transport === undefined
            ? {}
            : { transport: redactTransport(status.config.transport) }),
          chargerCapabilities: status.config.chargerCapabilities,
          tlsCaPath: status.config.tlsCaPath,
          tlsCertPath: status.config.tlsCertPath,
          tlsKeyPath: status.config.tlsKeyPath,
          bootNotification: status.config.bootNotification,
          labels: status.config.labels,
          ...(status.config.behaviors === undefined
            ? {}
            : { behaviors: status.config.behaviors }),
          ...(status.config.behaviorParams === undefined
            ? {}
            : { behaviorParams: status.config.behaviorParams }),
        }
      : undefined,
  };
}

export function toConnectorSnapshot(
  connector: ChargePointStatus["connectors"][number],
): ConnectorSnapshot {
  return {
    id: connector.id,
    status: connector.status as OCPPStatus,
    availability: connector.availability as OCPPAvailability,
    meterValue: connector.meterValue,
    transactionId: connector.transactionId,
    soc: connector.soc,
    mode: connector.mode as ScenarioMode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig:
      connector.autoMeterValueConfig as unknown as AutoMeterValueConfig | null,
    evSettings: connector.evSettings as unknown as EVSettings | null,
    chargingProfile:
      connector.chargingProfile as unknown as ActiveChargingProfile | null,
    chargingProfiles:
      connector.chargingProfiles as unknown as ActiveChargingProfile[],
    transactionStartTime: connector.transactionStartTime
      ? new Date(connector.transactionStartTime)
      : null,
    transactionTagId: connector.transactionTagId,
    transactionBatteryCapacityKwh: connector.transactionBatteryCapacityKwh,
    evConnection: connector.evConnection,
  };
}

export function toChargePointEvent(evt: CLIEvent): ChargePointEvent | null {
  switch (evt.event) {
    case "connected":
      return { type: "connected" };
    case "disconnected":
      return {
        type: "disconnected",
        code: evt.data.code,
        reason: evt.data.reason,
      };
    case "status_change":
      return { type: "status", status: evt.data.status as OCPPStatus };
    case "error":
      return { type: "error", error: evt.data.error };
    case "connector_status":
      return {
        type: "connector-status",
        connectorId: evt.data.connectorId,
        status: evt.data.status as OCPPStatus,
        previousStatus: evt.data.previousStatus as OCPPStatus,
      };
    case "transaction_started":
      return {
        type: "connector-transaction",
        connectorId: evt.data.connectorId,
        transactionId: evt.data.transactionId,
      };
    case "transaction_stopped":
      return {
        type: "connector-transaction",
        connectorId: evt.data.connectorId,
        transactionId: null,
      };
    case "meter_value":
      return {
        type: "connector-meter",
        connectorId: evt.data.connectorId,
        meterValue: evt.data.meterValue,
      };
    case "log":
      return {
        type: "log",
        entry: {
          timestamp: new Date(),
          level:
            typeof evt.data.level === "number"
              ? (evt.data.level as LogLevel)
              : LogLevel.INFO,
          type:
            typeof evt.data.type === "string"
              ? (evt.data.type as LogType)
              : LogType.GENERAL,
          message: evt.data.message,
        },
      };
    case "scenario_started":
      return {
        type: "scenario-started",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
      };
    case "scenario_completed":
      return {
        type: "scenario-completed",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
      };
    case "scenario_error":
      return {
        type: "scenario-error",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
        error: evt.data.error,
      };
    case "scenario_node_execute":
      return {
        type: "scenario-node-execute",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
        nodeId: evt.data.nodeId,
      };
    case "scenario_run_recorded":
      return {
        type: "scenario-run-recorded",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
      };
    case "scenario_wait_changed":
      return {
        type: "scenario-wait-changed",
        connectorId: evt.data.connectorId,
        scenarioId: evt.data.scenarioId,
        runId: evt.data.runId,
        nodeId: evt.data.nodeId,
        kind: evt.data.kind,
      };
    case "connector_availability":
      return {
        type: "connector-availability",
        connectorId: evt.data.connectorId,
        availability: evt.data.availability as OCPPAvailability,
      };
    case "connector_soc":
      return {
        type: "connector-soc",
        connectorId: evt.data.connectorId,
        soc: evt.data.soc,
      };
    case "connector_mode":
      return {
        type: "connector-mode",
        connectorId: evt.data.connectorId,
        mode: evt.data.mode as ScenarioMode,
      };
    case "connector_auto_reset":
      return {
        type: "connector-auto-reset-to-available",
        connectorId: evt.data.connectorId,
        enabled: evt.data.enabled,
      };
    case "connector_auto_meter":
      return {
        type: "connector-auto-meter",
        connectorId: evt.data.connectorId,
        config: evt.data.config,
      };
    case "connector_ev_settings":
      return {
        type: "connector-ev-settings",
        connectorId: evt.data.connectorId,
        settings: evt.data.settings,
      };
    case "connector_charging_profile":
      return {
        type: "connector-charging-profile",
        connectorId: evt.data.connectorId,
        profile: evt.data.profile,
      };
    case "connector_charging_profiles":
      return {
        type: "connector-charging-profiles",
        connectorId: evt.data.connectorId,
        profiles: [...evt.data.profiles],
      };
    case "heartbeat":
      return {
        type: "heartbeat",
        intervalSeconds: evt.data.intervalSeconds,
        lastSentAt: evt.data.lastSentAt,
      };
    case "state_history_entry":
      return {
        type: "state-history-entry",
        entry: evt.data.entry,
      };
    case "connector_removed":
      return {
        type: "connector-removed",
        connectorId: evt.data.connectorId,
      };
    default:
      return null;
  }
}
