import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import { ActiveChargingProfile } from "../cp/domain/connector/Connector";

const STORAGE_KEY_PREFIX = "connector_auto_meter_";
const CHARGING_PROFILE_KEY_PREFIX = "connector_charging_profiles_";

/**
 * Save connector's auto MeterValue configuration to localStorage
 */
export function saveConnectorAutoMeterConfig(
  chargePointId: string,
  connectorId: number,
  config: AutoMeterValueConfig,
): void {
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    localStorage.setItem(key, JSON.stringify(config));
  } catch (error) {
    console.error("Failed to save connector auto meter config:", error);
  }
}

/**
 * Load connector's auto MeterValue configuration from localStorage
 */
export function loadConnectorAutoMeterConfig(
  chargePointId: string,
  connectorId: number,
): AutoMeterValueConfig | null {
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored) as AutoMeterValueConfig;
    }
  } catch (error) {
    console.error("Failed to load connector auto meter config:", error);
  }
  return null;
}

/**
 * Clear connector's auto MeterValue configuration from localStorage
 */
export function clearConnectorAutoMeterConfig(
  chargePointId: string,
  connectorId: number,
): void {
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error("Failed to clear connector auto meter config:", error);
  }
}

/**
 * Clear all connector auto MeterValue configurations for a charge point
 */
export function clearChargePointAutoMeterConfigs(chargePointId: string): void {
  try {
    const keys = Object.keys(localStorage);
    const prefix = `${STORAGE_KEY_PREFIX}${chargePointId}_`;
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    });
  } catch (error) {
    console.error("Failed to clear charge point auto meter configs:", error);
  }
}

// ============================================
// Charging Profile Storage Functions
// ============================================

/**
 * Save connector's charging profiles to localStorage
 */
export function saveConnectorChargingProfiles(
  chargePointId: string,
  connectorId: number,
  profiles: ActiveChargingProfile[],
): void {
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    localStorage.setItem(key, JSON.stringify(profiles));
  } catch (error) {
    console.error("Failed to save connector charging profiles:", error);
  }
}

/**
 * Load connector's charging profiles from localStorage
 */
export function loadConnectorChargingProfiles(
  chargePointId: string,
  connectorId: number,
): ActiveChargingProfile[] {
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored) as ActiveChargingProfile[];
    }
  } catch (error) {
    console.error("Failed to load connector charging profiles:", error);
  }
  return [];
}

/**
 * Clear connector's charging profiles from localStorage
 */
export function clearConnectorChargingProfiles(
  chargePointId: string,
  connectorId: number,
): void {
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.error("Failed to clear connector charging profiles:", error);
  }
}

/**
 * Clear all connector charging profiles for a charge point
 */
export function clearChargePointChargingProfiles(chargePointId: string): void {
  try {
    const keys = Object.keys(localStorage);
    const prefix = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_`;
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    });
  } catch (error) {
    console.error("Failed to clear charge point charging profiles:", error);
  }
}
