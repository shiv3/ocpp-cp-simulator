import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";
import {
  loadConnectorAutoMeterConfig,
  saveConnectorAutoMeterConfig,
  clearConnectorAutoMeterConfig,
  clearChargePointAutoMeterConfigs,
} from "../../utils/connectorStorage";

export class LocalConnectorSettingsRepository implements ConnectorSettingsRepository {
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

  async clearAutoMeterValueConfig(chargePointId: string, connectorId: number): Promise<void> {
    clearConnectorAutoMeterConfig(chargePointId, connectorId);
  }

  async clearAllAutoMeterValueConfigs(chargePointId: string): Promise<void> {
    clearChargePointAutoMeterConfigs(chargePointId);
  }
}
