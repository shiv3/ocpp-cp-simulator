import type { EventEnvelope } from "@ocpp-cp-simulator/contracts/index";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { LogLevel, LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { ScenarioMode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { TimelineEntry } from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type { ChargingSession } from "@ocpp-cp-simulator/core/cp/domain/session/ChargingSession";
import type { StateHistoryEntry } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type { ChargePointEvent } from "../interfaces/ChargePointService";

type CpEventEnvelope = Extract<EventEnvelope, { kind: "cp" }>;
type ServerCpEvent = CpEventEnvelope["evt"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function mapServerEventToChargePointEvent(
  evt: ServerCpEvent,
): ChargePointEvent | null {
  const data = isRecord(evt.data) ? evt.data : {};

  switch (evt.event) {
    case "connected":
      return { type: "connected" };
    case "disconnected":
      return {
        type: "disconnected",
        code: typeof data.code === "number" ? data.code : 0,
        reason: typeof data.reason === "string" ? data.reason : "",
      };
    case "status_change":
      return typeof data.status === "string"
        ? { type: "status", status: data.status as OCPPStatus }
        : null;
    case "error":
      return typeof data.error === "string"
        ? { type: "error", error: data.error }
        : null;
    case "connector_status":
      if (
        typeof data.connectorId === "number" &&
        typeof data.status === "string" &&
        typeof data.previousStatus === "string"
      ) {
        return {
          type: "connector-status",
          connectorId: data.connectorId,
          status: data.status as OCPPStatus,
          previousStatus: data.previousStatus as OCPPStatus,
        };
      }
      return null;
    case "transaction_started":
      if (
        typeof data.connectorId === "number" &&
        typeof data.transactionId === "number"
      ) {
        return {
          type: "connector-transaction",
          connectorId: data.connectorId,
          transactionId: data.transactionId,
        };
      }
      return null;
    case "transaction_stopped":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-transaction",
          connectorId: data.connectorId,
          transactionId: null,
        };
      }
      return null;
    case "meter_value":
      if (
        typeof data.connectorId === "number" &&
        typeof data.meterValue === "number"
      ) {
        return {
          type: "connector-meter",
          connectorId: data.connectorId,
          meterValue: data.meterValue,
        };
      }
      return null;
    case "log": {
      const level =
        typeof data.level === "number"
          ? (data.level as LogLevel)
          : LogLevel.INFO;
      const typeStr =
        typeof data.type === "string"
          ? (data.type as LogType)
          : LogType.GENERAL;
      const message = typeof data.message === "string" ? data.message : "";
      const ts = evt.timestamp ? new Date(evt.timestamp) : new Date();
      return {
        type: "log",
        entry: { timestamp: ts, level, type: typeStr, message },
      };
    }
    case "connector_availability":
      if (
        typeof data.connectorId === "number" &&
        typeof data.availability === "string"
      ) {
        return {
          type: "connector-availability",
          connectorId: data.connectorId,
          availability: data.availability as OCPPAvailability,
        };
      }
      return null;
    case "connector_soc":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-soc",
          connectorId: data.connectorId,
          soc: typeof data.soc === "number" ? data.soc : null,
        };
      }
      return null;
    case "connector_mode":
      if (
        typeof data.connectorId === "number" &&
        typeof data.mode === "string"
      ) {
        return {
          type: "connector-mode",
          connectorId: data.connectorId,
          mode: data.mode as ScenarioMode,
        };
      }
      return null;
    case "connector_auto_reset":
      if (
        typeof data.connectorId === "number" &&
        typeof data.enabled === "boolean"
      ) {
        return {
          type: "connector-auto-reset-to-available",
          connectorId: data.connectorId,
          enabled: data.enabled,
        };
      }
      return null;
    case "connector_auto_meter":
      if (typeof data.connectorId === "number" && isRecord(data.config)) {
        return {
          type: "connector-auto-meter",
          connectorId: data.connectorId,
          config: data.config as unknown as AutoMeterValueConfig,
        };
      }
      return null;
    case "connector_ev_settings":
      if (typeof data.connectorId === "number" && isRecord(data.settings)) {
        return {
          type: "connector-ev-settings",
          connectorId: data.connectorId,
          settings: data.settings as unknown as EVSettings,
        };
      }
      return null;
    case "connector_charging_profile":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-charging-profile",
          connectorId: data.connectorId,
          profile: isRecord(data.profile)
            ? (data.profile as unknown as ActiveChargingProfile)
            : null,
        };
      }
      return null;
    case "connector_charging_profiles":
      if (
        typeof data.connectorId === "number" &&
        Array.isArray(data.profiles)
      ) {
        return {
          type: "connector-charging-profiles",
          connectorId: data.connectorId,
          profiles: data.profiles as unknown as ActiveChargingProfile[],
        };
      }
      return null;
    case "scenario_started":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string"
      ) {
        return {
          type: "scenario-started",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        };
      }
      return null;
    case "scenario_completed":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string"
      ) {
        return {
          type: "scenario-completed",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        };
      }
      return null;
    case "scenario_error":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.error === "string"
      ) {
        return {
          type: "scenario-error",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
          error: data.error,
        };
      }
      return null;
    case "scenario_node_execute":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.nodeId === "string"
      ) {
        return {
          type: "scenario-node-execute",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
          nodeId: data.nodeId,
        };
      }
      return null;
    case "timeline_entry":
      // Consumers ignore kinds they do not know (format 1.x), so the kind
      // is not checked against this build's list.
      if (
        typeof data.seq === "number" &&
        typeof data.timestamp === "string" &&
        typeof data.kind === "string" &&
        typeof data.cpId === "string" &&
        typeof data.summary === "string"
      ) {
        return {
          type: "timeline-entry",
          entry: data as unknown as TimelineEntry,
        };
      }
      return null;
    case "charging_session":
      if (
        typeof data.sessionId === "string" &&
        typeof data.cpId === "string" &&
        typeof data.connectorId === "number" &&
        typeof data.startedAt === "string" &&
        typeof data.outcome === "string"
      ) {
        return {
          type: "charging-session",
          session: data as unknown as ChargingSession,
        };
      }
      return null;
    case "scenario_run_recorded":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.runId === "string"
      ) {
        return {
          type: "scenario-run-recorded",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          runId: data.runId,
        };
      }
      return null;
    case "scenario_wait_changed":
      if (
        typeof data.connectorId === "number" &&
        typeof data.scenarioId === "string" &&
        typeof data.nodeId === "string" &&
        (data.kind === "extend" ||
          data.kind === "retry" ||
          data.kind === "continue")
      ) {
        return {
          type: "scenario-wait-changed",
          connectorId: data.connectorId,
          scenarioId: data.scenarioId,
          ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
          nodeId: data.nodeId,
          kind: data.kind,
        };
      }
      return null;
    case "connector_removed":
      if (typeof data.connectorId === "number") {
        return {
          type: "connector-removed",
          connectorId: data.connectorId,
        };
      }
      return null;
    case "heartbeat":
      if (typeof data.intervalSeconds === "number") {
        return {
          type: "heartbeat",
          intervalSeconds: data.intervalSeconds,
          lastSentAt:
            typeof data.lastSentAt === "string" ? data.lastSentAt : null,
        };
      }
      return null;
    case "state_history_entry":
      if (isRecord(data.entry)) {
        const raw = data.entry as Record<string, unknown>;
        const timestamp =
          typeof raw.timestamp === "string"
            ? new Date(raw.timestamp)
            : new Date();
        return {
          type: "state-history-entry",
          entry: { ...raw, timestamp } as unknown as StateHistoryEntry,
        };
      }
      return null;
    default:
      return null;
  }
}
