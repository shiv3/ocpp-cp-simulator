import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
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
}
