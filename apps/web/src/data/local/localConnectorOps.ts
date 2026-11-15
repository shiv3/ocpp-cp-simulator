/** Connector settings, charging-profile / history / session reads and configuration keys: split out of LocalChargePointService (#877). */
import {
  readConfigurationKeys,
  writeConfigurationKey,
  type ConfigurationKeyList,
  type ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import { configurationWriteCheckV201 } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/v201/setVariablesV201";
import { isOcpp2Version } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  type EVSettings,
  type EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { ScenarioMode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import {
  getExistingChargePointOrThrow,
  requireConnector,
  scenarioManagerOf,
  type LocalServiceHost,
} from "./localHost";

export async function setEVSettings(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  settings: EVSettingsPatch,
): Promise<void> {
  // Explicit set (#105): marks the connector overridden so a later
  // Default EV Settings propagation doesn't clobber it.
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.applyEvSettingsOverride(settings);
  // The operator now owns the override, so no run does — a run in flight
  // that claimed it earlier must not release this set when it ends (#333).
  scenarioManagerOf(host, id, connector)?.disownEvSettingsOverride();
}

export async function getEVSettings(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<EVSettings | null> {
  return (
    requireConnector(host.chargePoints, id, connectorId).evSettings ?? null
  );
}

export async function applyDefaultEVSettings(
  host: LocalServiceHost,
  settings: EVSettingsPatch,
): Promise<void> {
  // Connectors freeze getDefaultEVSettings() at construction, so a mid-session
  // change to the Default EV Settings wouldn't reach the ones already live.
  // Push it onto every connector (per-connector EV settings aren't a
  // user-editable, persisted concept — they only come from the default or a
  // running scenario) so the editor reflects the new default immediately (#107).
  // Connectors with an active explicit/scenario override skip this (#105) —
  // see Connector.applyDefaultEvSettings.
  host.chargePoints.forEach((chargePoint) => {
    chargePoint.connectors.forEach((connector) => {
      connector.applyDefaultEvSettings(settings);
    });
  });
}

export async function setAutoMeterValueConfig(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  config: AutoMeterValueConfig,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.autoMeterValueConfig = config;
}

export async function getAutoMeterValueConfig(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<AutoMeterValueConfig | null> {
  return (
    requireConnector(host.chargePoints, id, connectorId).autoMeterValueConfig ??
    null
  );
}

export async function getAutoMeterConfig(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<AutoMeterValueConfig | null> {
  return host.connectorSettingsRepository.loadAutoMeterValueConfig(
    id,
    connectorId,
  );
}

export async function saveAutoMeterConfig(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  config: AutoMeterValueConfig,
): Promise<void> {
  await host.connectorSettingsRepository.saveAutoMeterValueConfig(
    id,
    connectorId,
    config,
  );
  await host.database?.flush?.();
}

export async function setAutoResetToAvailable(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  enabled: boolean,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.autoResetToAvailable = enabled;
}

export async function setConnectorMode(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  mode: ScenarioMode,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.mode = mode;
}

export async function setConnectorSoc(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  soc: number | null,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.soc = soc;
}

export async function setConnectorSocMeterSync(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  enabled: boolean,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  connector.socMeterSyncEnabled = enabled;
}

export async function getSocMeterSync(
  host: LocalServiceHost,
  _id: string,
  _connectorId: number,
): Promise<boolean> {
  return host.connectorSettingsRepository.loadSocMeterSync();
}

export async function saveSocMeterSync(
  host: LocalServiceHost,
  _id: string,
  _connectorId: number,
  enabled: boolean,
): Promise<void> {
  await host.connectorSettingsRepository.saveSocMeterSync(enabled);
  await host.database?.flush?.();
}

export async function getChargingProfiles(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<ReadonlyArray<ActiveChargingProfile>> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  return [...connector.chargingProfiles];
}

export async function getStateHistory(
  host: LocalServiceHost,
  id: string,
  options?: HistoryOptions,
): Promise<StateHistoryEntry[]> {
  const cp = host.chargePoints.get(id);
  if (!cp) return [];
  return cp.stateManager.history.getHistory(options);
}

export async function getOperationalTimeline(
  host: LocalServiceHost,
  id: string,
  query?: TimelineQuery,
): Promise<TimelinePage> {
  const cp = host.chargePoints.get(id);
  if (!cp) return { entries: [], total: 0 };
  return cp.timeline.query(query);
}

export async function listChargingSessions(
  host: LocalServiceHost,
  id: string,
  query: Omit<ChargingSessionQuery, "cpId"> = {},
): Promise<ChargingSessionPage> {
  return host.chargingSessions.list({ ...query, cpId: id });
}

export async function getConfigurationKeys(
  host: LocalServiceHost,
  id: string,
  keys: readonly string[] = [],
): Promise<ConfigurationKeyList> {
  const cp = getExistingChargePointOrThrow(host.chargePoints, id);
  return readConfigurationKeys(
    cp.configuration,
    isOcpp2Version(cp.ocppVersion),
    keys,
  );
}

export async function setConfigurationKey(
  host: LocalServiceHost,
  id: string,
  key: string,
  value: string,
): Promise<ConfigurationSetStatus> {
  const cp = getExistingChargePointOrThrow(host.chargePoints, id);
  return writeConfigurationKey(
    cp.configuration,
    isOcpp2Version(cp.ocppVersion),
    key,
    value,
    cp.logger,
    isOcpp2Version(cp.ocppVersion)
      ? configurationWriteCheckV201(cp.ocppVersion)
      : undefined,
  );
}
