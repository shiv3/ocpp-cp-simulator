import { schemas } from "../../../../ocpp";
import { parseOcppVersion } from "../../../domain/types/OcppVersion";
import { defaultPayloadFromSchema } from "./defaultPayload";
import { outgoingV16Warning } from "./validateV16";
import { outgoingV201Warning } from "./validateV201";
import { outgoingV21Warning } from "./validateV21";

/**
 * What an expert OCPP call (#389) may send on one OCPP-J version: the
 * station-initiated actions, the same outgoing schema check normal traffic
 * runs, and a starting payload per action. Browser-safe — the schemas are
 * static imports — so the console builds its form from it too.
 */
export interface OcppCallCatalog {
  readonly actions: readonly string[];
  isSupported(action: string): boolean;
  /** The codec's outgoing warning: null when the payload is schema-valid. */
  validate(action: string, payload: unknown): string | null;
  defaultPayload(action: string): Record<string, unknown>;
}

// Station→CSMS CALLs. A test pins each list against the version's request
// schemas and its inbound (CSMS→station) registry: every request schema is on
// exactly one side, DataTransfer on both.
const V16_ACTIONS = [
  "Authorize",
  "BootNotification",
  "DataTransfer",
  "DiagnosticsStatusNotification",
  "FirmwareStatusNotification",
  "Heartbeat",
  "MeterValues",
  "StartTransaction",
  "StatusNotification",
  "StopTransaction",
  // 1.6 Security Whitepaper
  "LogStatusNotification",
  "SecurityEventNotification",
  "SignCertificate",
  "SignedFirmwareStatusNotification",
] as const;

const V201_ACTIONS = [
  "Authorize",
  "BootNotification",
  "ClearedChargingLimit",
  "DataTransfer",
  "FirmwareStatusNotification",
  "Get15118EVCertificate",
  "GetCertificateStatus",
  "Heartbeat",
  "LogStatusNotification",
  "MeterValues",
  "NotifyChargingLimit",
  "NotifyCustomerInformation",
  "NotifyDisplayMessages",
  "NotifyEVChargingNeeds",
  "NotifyEVChargingSchedule",
  "NotifyEvent",
  "NotifyMonitoringReport",
  "NotifyReport",
  "PublishFirmwareStatusNotification",
  "ReportChargingProfiles",
  "ReservationStatusUpdate",
  "SecurityEventNotification",
  "SignCertificate",
  "StatusNotification",
  "TransactionEvent",
] as const;

// 2.1 keeps every 2.0.1 station message and adds these. Its
// NotifyPeriodicEventStream is an OCPP-J SEND (no response), not a CALL.
const V21_ACTIONS = [
  ...V201_ACTIONS,
  "BatterySwap",
  "ClosePeriodicEventStream",
  "GetCertificateChainStatus",
  "NotifyDERAlarm",
  "NotifyDERStartStop",
  "NotifyPriorityCharging",
  "NotifySettlement",
  "OpenPeriodicEventStream",
  "PullDynamicScheduleUpdate",
  "ReportDERControl",
  "VatNumberValidation",
].sort();

function buildCatalog(
  actions: readonly string[],
  schemaMap: Record<string, object>,
  schemaSuffix: string,
  outgoingWarning: (action: string, payload: unknown) => string | null,
): OcppCallCatalog {
  const supported = new Set(actions);
  return {
    actions,
    isSupported: (action) => supported.has(action),
    validate: outgoingWarning,
    defaultPayload: (action) => {
      const key = `${action.charAt(0).toLowerCase()}${action.slice(1)}Request${schemaSuffix}`;
      const schema = schemaMap[key];
      return schema
        ? (defaultPayloadFromSchema(schema) as Record<string, unknown>)
        : {};
    },
  };
}

const V16_CATALOG = buildCatalog(
  V16_ACTIONS,
  schemas.v16,
  "V16",
  outgoingV16Warning,
);
const V201_CATALOG = buildCatalog(
  V201_ACTIONS,
  schemas.v201,
  "V201",
  outgoingV201Warning,
);
const V21_CATALOG = buildCatalog(
  V21_ACTIONS,
  schemas.v21,
  "V21",
  outgoingV21Warning,
);

/** The catalog for an OCPP-J version; null for SOAP (1.2, 1.5, 1.6-S), whose
 *  envelopes are built per operation and have no arbitrary-action path. */
export function getOcppCallCatalog(
  ocppVersion: string,
): OcppCallCatalog | null {
  switch (parseOcppVersion(ocppVersion)) {
    case "OCPP-1.6J":
      return V16_CATALOG;
    case "OCPP-2.0.1":
      return V201_CATALOG;
    case "OCPP-2.1":
      return V21_CATALOG;
    default:
      return null;
  }
}
