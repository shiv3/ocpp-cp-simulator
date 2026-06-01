import { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import { ActiveChargingProfile } from "../cp/domain/connector/Connector";
import type { OCPPAvailability } from "../cp/domain/types/OcppTypes";

const STORAGE_KEY_PREFIX = "connector_auto_meter_";
const CHARGING_PROFILE_KEY_PREFIX = "connector_charging_profiles_";
const SOC_METER_SYNC_KEY = "connector_soc_meter_sync";
const CONNECTOR_AVAILABILITY_PREFIX = "connector_availability_";
const CHARGEPOINT_AVAILABILITY_PREFIX = "chargepoint_availability_";

// localStorage is browser-only. The CLI/daemon runtime (Bun/Node) shares
// this file via the domain modules, so guard every access — a null return
// means "no persistent store available, treat as empty".
function getStore(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Persist a connector's availability across reboots. OCPP 1.6 §5.2 requires
 * Unavailable set via ChangeAvailability to survive a reboot.
 */
export function saveConnectorAvailability(
  chargePointId: string,
  connectorId: number,
  availability: OCPPAvailability,
): void {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(
      `${CONNECTOR_AVAILABILITY_PREFIX}${chargePointId}_${connectorId}`,
      availability,
    );
  } catch (error) {
    console.error("Failed to save connector availability:", error);
  }
}

export function loadConnectorAvailability(
  chargePointId: string,
  connectorId: number,
): OCPPAvailability | null {
  const store = getStore();
  if (!store) return null;
  try {
    const raw = store.getItem(
      `${CONNECTOR_AVAILABILITY_PREFIX}${chargePointId}_${connectorId}`,
    );
    if (raw === "Operative" || raw === "Inoperative") return raw;
    return null;
  } catch (error) {
    console.error("Failed to load connector availability:", error);
    return null;
  }
}

/** Persistence for the CP-level (connectorId=0) availability flag. */
export function saveChargePointAvailability(
  chargePointId: string,
  availability: OCPPAvailability,
): void {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(
      `${CHARGEPOINT_AVAILABILITY_PREFIX}${chargePointId}`,
      availability,
    );
  } catch (error) {
    console.error("Failed to save CP availability:", error);
  }
}

export function loadChargePointAvailability(
  chargePointId: string,
): OCPPAvailability | null {
  const store = getStore();
  if (!store) return null;
  try {
    const raw = store.getItem(
      `${CHARGEPOINT_AVAILABILITY_PREFIX}${chargePointId}`,
    );
    if (raw === "Operative" || raw === "Inoperative") return raw;
    return null;
  } catch (error) {
    console.error("Failed to load CP availability:", error);
    return null;
  }
}

/**
 * Whether the Battery card's SoC slider and Meter input should keep each
 * other in sync (using `evSettings.batteryCapacityKwh` and `initialSoc`
 * to convert between Wh and %). Persisted globally — same preference
 * applies to every connector.
 */
export function loadSocMeterSyncEnabled(): boolean {
  const store = getStore();
  if (!store) return true;
  try {
    const stored = store.getItem(SOC_METER_SYNC_KEY);
    if (stored === null) return true; // default ON
    return stored === "true";
  } catch {
    return true;
  }
}

export function saveSocMeterSyncEnabled(enabled: boolean): void {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(SOC_METER_SYNC_KEY, enabled ? "true" : "false");
  } catch (error) {
    console.error("Failed to save SoC↔Meter sync preference:", error);
  }
}

/**
 * Save connector's auto MeterValue configuration to localStorage
 */
export function saveConnectorAutoMeterConfig(
  chargePointId: string,
  connectorId: number,
  config: AutoMeterValueConfig,
): void {
  const store = getStore();
  if (!store) return;
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    store.setItem(key, JSON.stringify(config));
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
  const store = getStore();
  if (!store) return null;
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    const stored = store.getItem(key);
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
  const store = getStore();
  if (!store) return;
  const key = `${STORAGE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    store.removeItem(key);
  } catch (error) {
    console.error("Failed to clear connector auto meter config:", error);
  }
}

/**
 * Clear all connector auto MeterValue configurations for a charge point
 */
export function clearChargePointAutoMeterConfigs(chargePointId: string): void {
  const store = getStore();
  if (!store) return;
  try {
    const keys = Object.keys(store);
    const prefix = `${STORAGE_KEY_PREFIX}${chargePointId}_`;
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        store.removeItem(key);
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
  const store = getStore();
  if (!store) return;
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    store.setItem(key, JSON.stringify(profiles));
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
  const store = getStore();
  if (!store) return [];
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    const stored = store.getItem(key);
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
  const store = getStore();
  if (!store) return;
  const key = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_${connectorId}`;
  try {
    store.removeItem(key);
  } catch (error) {
    console.error("Failed to clear connector charging profiles:", error);
  }
}

/**
 * Clear all connector charging profiles for a charge point
 */
export function clearChargePointChargingProfiles(chargePointId: string): void {
  const store = getStore();
  if (!store) return;
  try {
    const keys = Object.keys(store);
    const prefix = `${CHARGING_PROFILE_KEY_PREFIX}${chargePointId}_`;
    keys.forEach((key) => {
      if (key.startsWith(prefix)) {
        store.removeItem(key);
      }
    });
  } catch (error) {
    console.error("Failed to clear charge point charging profiles:", error);
  }
}
