import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { OCPPAvailability } from "../../cp/domain/types/OcppTypes";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";
import {
  loadConnectorAutoMeterConfig,
  saveConnectorAutoMeterConfig,
  clearConnectorAutoMeterConfig,
  clearChargePointAutoMeterConfigs,
  loadConnectorChargingProfiles,
  saveConnectorChargingProfiles,
  clearConnectorChargingProfiles,
  clearChargePointChargingProfiles,
  loadConnectorAvailability,
  saveConnectorAvailability,
  loadChargePointAvailability,
  saveChargePointAvailability,
  loadSocMeterSyncEnabled,
  saveSocMeterSyncEnabled,
} from "../../utils/connectorStorage";

export class LocalConnectorSettingsRepository
  implements ConnectorSettingsRepository
{
  async loadAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    return loadConnectorAutoMeterConfig(chargePointId, connectorId);
  }

  async saveAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    saveConnectorAutoMeterConfig(chargePointId, connectorId, config);
  }

  async clearAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<void> {
    clearConnectorAutoMeterConfig(chargePointId, connectorId);
  }

  async clearAllAutoMeterValueConfigs(chargePointId: string): Promise<void> {
    clearChargePointAutoMeterConfigs(chargePointId);
  }

  async loadChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<ActiveChargingProfile[]> {
    return loadConnectorChargingProfiles(chargePointId, connectorId);
  }

  async saveChargingProfiles(
    chargePointId: string,
    connectorId: number,
    profiles: ActiveChargingProfile[],
  ): Promise<void> {
    saveConnectorChargingProfiles(chargePointId, connectorId, profiles);
  }

  async clearChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<void> {
    clearConnectorChargingProfiles(chargePointId, connectorId);
  }

  async clearAllChargingProfiles(chargePointId: string): Promise<void> {
    clearChargePointChargingProfiles(chargePointId);
  }

  async loadAvailability(
    chargePointId: string,
    connectorId: number,
  ): Promise<OCPPAvailability | null> {
    return connectorId === 0
      ? loadChargePointAvailability(chargePointId)
      : loadConnectorAvailability(chargePointId, connectorId);
  }

  async saveAvailability(
    chargePointId: string,
    connectorId: number,
    availability: OCPPAvailability,
  ): Promise<void> {
    if (connectorId === 0) {
      saveChargePointAvailability(chargePointId, availability);
    } else {
      saveConnectorAvailability(chargePointId, connectorId, availability);
    }
  }

  async loadSocMeterSync(): Promise<boolean> {
    return loadSocMeterSyncEnabled();
  }

  async saveSocMeterSync(enabled: boolean): Promise<void> {
    saveSocMeterSyncEnabled(enabled);
  }
}
