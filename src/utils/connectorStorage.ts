import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";

const STORAGE_KEY_PREFIX = "connector_auto_meter_";

/**
 * Save connector's auto MeterValue configuration to localStorage
 */
export function saveConnectorAutoMeterConfig(
  chargePointId: string,
  connectorId: number,
  config: AutoMeterValueConfig
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
  connectorId: number
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
  connectorId: number
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
export function clearChargePointAutoMeterConfigs(
  chargePointId: string
): void {
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
