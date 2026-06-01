import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { OCPPAvailability } from "../../cp/domain/types/OcppTypes";

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

  /** Per-connector availability persisted across reboots (OCPP 1.6 §5.2).
   *  Use `connectorId = 0` for the CP-level value. `null` means
   *  "no override", i.e. start at the default. */
  loadAvailability(
    chargePointId: string,
    connectorId: number,
  ): Promise<OCPPAvailability | null>;
  saveAvailability(
    chargePointId: string,
    connectorId: number,
    availability: OCPPAvailability,
  ): Promise<void>;

  /** Global UI preference for SoC↔Meter sync. Stored once per browser
   *  profile (not per CP/connector) — the cpId/connectorId are accepted
   *  on the setter so callers don't have to special-case, but the
   *  implementation collapses them to a single row. */
  loadSocMeterSync(): Promise<boolean>;
  saveSocMeterSync(enabled: boolean): Promise<void>;
}
