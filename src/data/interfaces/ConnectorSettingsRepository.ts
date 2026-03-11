import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";

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
  clearAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<void>;
  clearAllAutoMeterValueConfigs(chargePointId: string): Promise<void>;

  loadChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<ActiveChargingProfile[]>;
  saveChargingProfiles(
    chargePointId: string,
    connectorId: number,
    profiles: ActiveChargingProfile[],
  ): Promise<void>;
  clearChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<void>;
  clearAllChargingProfiles(chargePointId: string): Promise<void>;
}
