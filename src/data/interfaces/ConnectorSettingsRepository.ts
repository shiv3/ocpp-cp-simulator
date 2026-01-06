import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";

export interface ConnectorSettingsRepository {
  loadAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null>;
  saveAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void>;
  clearAutoMeterValueConfig(chargePointId: string, connectorId: number): Promise<void>;
  clearAllAutoMeterValueConfigs(chargePointId: string): Promise<void>;
}
