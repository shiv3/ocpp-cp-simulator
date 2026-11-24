import type {
  CpListItem,
  StatusWire,
} from "@ocpp-cp-simulator/contracts/index";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { ScenarioMode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type {
  ChargePointEvent,
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../interfaces/ChargePointService";

type ServerConnectorStatus = StatusWire["connectors"][number];
type WireConfig = NonNullable<StatusWire["config"]>;

export function emptyConnectorSnapshot(id: number): ConnectorSnapshot {
  return {
    id,
    status: "Unavailable" as OCPPStatus,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: true,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
  };
}

export function toConnectorSnapshot(
  c: ServerConnectorStatus,
): ConnectorSnapshot {
  return {
    id: c.id,
    status: c.status as OCPPStatus,
    availability: c.availability as OCPPAvailability,
    meterValue: c.meterValue,
    transactionId: c.transactionId,
    soc: c.soc ?? null,
    mode: (c.mode as ScenarioMode) ?? "manual",
    autoResetToAvailable: c.autoResetToAvailable ?? true,
    autoMeterValueConfig:
      (c.autoMeterValueConfig as unknown as AutoMeterValueConfig | null) ??
      null,
    evSettings: (c.evSettings as unknown as EVSettings | null) ?? null,
    chargingProfile:
      (c.chargingProfile as unknown as ActiveChargingProfile | null) ?? null,
    chargingProfiles:
      (c.chargingProfiles as unknown as ActiveChargingProfile[]) ?? [],
    transactionStartTime: c.transactionStartTime
      ? new Date(c.transactionStartTime)
      : null,
    transactionTagId: c.transactionTagId ?? null,
    transactionBatteryCapacityKwh: c.transactionBatteryCapacityKwh ?? null,
    evConnection: c.evConnection,
  };
}

export function toChargePointSnapshot(s: StatusWire): ChargePointSnapshot {
  return {
    id: s.id,
    status: s.status as OCPPStatus,
    error: s.error ?? "",
    connectors: (s.connectors ?? []).map(toConnectorSnapshot),
    heartbeat: s.heartbeat
      ? {
          intervalSeconds: s.heartbeat.intervalSeconds,
          lastSentAt: s.heartbeat.lastSentAt,
        }
      : undefined,
    networkSim: s.networkSim ?? null,
    ...(s.modem ? { modem: s.modem } : {}),
    config: s.config ? toSnapshotConfig(s.config) : undefined,
  };
}

export function toSnapshotConfig(
  config: WireConfig,
): ChargePointSnapshot["config"] {
  return {
    wsUrl: config.wsUrl,
    centralSystemUrl: config.centralSystemUrl,
    soapCallbackUrl: config.soapCallbackUrl,
    soapCallbackUrlDerived: config.soapCallbackUrlDerived,
    soapPath: config.soapPath,
    ocppVersion: config.ocppVersion,
    connectors: config.connectors,
    vendor: config.vendor,
    model: config.model,
    // The socket protocol intentionally redacts passwords. The legacy browser
    // interface still requires a password field, so remote snapshots expose an
    // empty placeholder instead of a secret the daemon will not send.
    basicAuth: config.basicAuth
      ? { username: config.basicAuth.username, password: "" }
      : null,
    securityProfile: config.securityProfile,
    cpoName: config.cpoName,
    txUpdatedMeterValues: config.txUpdatedMeterValues,
    inboundValidation: config.inboundValidation,
    reservationAuthorizeIdTag: config.reservationAuthorizeIdTag,
    meterValueDecimalSeparator: config.meterValueDecimalSeparator,
    emptyMeterValues: config.emptyMeterValues,
    capabilityProfile: config.capabilityProfile,
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    chargerCapabilities: config.chargerCapabilities,
    tlsCaPath: config.tlsCaPath,
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    bootNotification: config.bootNotification ?? null,
    labels: config.labels,
    ...(config.behaviors === undefined ? {} : { behaviors: config.behaviors }),
    ...(config.behaviorParams === undefined
      ? {}
      : { behaviorParams: config.behaviorParams }),
  };
}

export function cpListItemToSnapshot(item: CpListItem): ChargePointSnapshot {
  const connectorCount = Math.max(0, item.connectors);
  return {
    id: item.cpId,
    status: item.status as OCPPStatus,
    error: "",
    connectors: Array.from({ length: connectorCount }, (_, i) =>
      emptyConnectorSnapshot(i + 1),
    ),
    networkSim: item.networkSim ?? null,
    config: toSnapshotConfig(item),
  };
}

export function snapshotToEvents(
  snapshot: ChargePointSnapshot,
): ChargePointEvent[] {
  const events: ChargePointEvent[] = [
    { type: "status", status: snapshot.status },
  ];
  if (snapshot.error) events.push({ type: "error", error: snapshot.error });
  if (snapshot.heartbeat) {
    events.push({
      type: "heartbeat",
      intervalSeconds: snapshot.heartbeat.intervalSeconds,
      lastSentAt: snapshot.heartbeat.lastSentAt,
    });
  }

  for (const connector of snapshot.connectors) {
    events.push({
      type: "connector-status",
      connectorId: connector.id,
      status: connector.status,
      previousStatus: connector.status,
    });
    events.push({
      type: "connector-availability",
      connectorId: connector.id,
      availability: connector.availability,
    });
    events.push({
      type: "connector-meter",
      connectorId: connector.id,
      meterValue: connector.meterValue,
    });
    events.push({
      type: "connector-transaction",
      connectorId: connector.id,
      transactionId: connector.transactionId,
    });
    events.push({
      type: "connector-soc",
      connectorId: connector.id,
      soc: connector.soc,
    });
    events.push({
      type: "connector-mode",
      connectorId: connector.id,
      mode: connector.mode,
    });
    events.push({
      type: "connector-auto-reset-to-available",
      connectorId: connector.id,
      enabled: connector.autoResetToAvailable,
    });
    if (connector.autoMeterValueConfig) {
      events.push({
        type: "connector-auto-meter",
        connectorId: connector.id,
        config: connector.autoMeterValueConfig,
      });
    }
    if (connector.evSettings) {
      events.push({
        type: "connector-ev-settings",
        connectorId: connector.id,
        settings: connector.evSettings,
      });
    }
    events.push({
      type: "connector-charging-profile",
      connectorId: connector.id,
      profile: connector.chargingProfile,
    });
    events.push({
      type: "connector-charging-profiles",
      connectorId: connector.id,
      profiles: [...connector.chargingProfiles],
    });
  }

  return events;
}
