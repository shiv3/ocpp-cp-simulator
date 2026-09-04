/** A point on the piecewise-linear charging curve. */
export interface ChargingCurvePoint {
  /** State of charge this point applies at, 0-100. */
  socPercent: number;
  /** Fraction of `maxChargingPowerKw` accepted there, 0-1. */
  powerFraction: number;
}

/** How the session ramps from zero to full acceptance. */
export type EvRampShape = "linear" | "sigmoid";

export interface EVSettings {
  modelName: string; // EV名/モデル
  batteryCapacityKwh: number; // バッテリー容量 (kWh)
  maxChargingPowerKw: number; // 最大充電電力 (kW)
  initialSoc: number; // 初期SoC (%)
  targetSoc: number; // 目標SoC (%)

  /**
   * Power acceptance against SoC, as a piecewise-linear curve (#301).
   *
   * Absent means the historical behaviour: flat acceptance at
   * `maxChargingPowerKw` for the whole session. Present, it is the shape a
   * real battery has — a DC session tapers well before 100%, and a CSMS
   * validating a load curve or a tariff calculation can see the difference.
   *
   * Sorted by `socPercent` at construction, so interpolation can assume a
   * monotone x-axis.
   */
  chargingCurve?: ChargingCurvePoint[];
  /** Ramp from session start to full acceptance. Absent means `linear`. */
  rampShape?: EvRampShape;
  /** `DC` has no reactive component; `AC` divides current by phases. */
  currentType?: "AC" | "DC";
  /** AC phases. 1 or 3; absent means 1. */
  phases?: 1 | 3;
  /** Phase-to-neutral volts. Absent means 230. */
  voltageV?: number;
  /** cos φ, AC only. Absent means 1 (unity). */
  powerFactor?: number;
}

export const defaultEVSettings: EVSettings = {
  modelName: "Generic EV",
  batteryCapacityKwh: 75,
  maxChargingPowerKw: 150,
  initialSoc: 20,
  targetSoc: 80,
};

/**
 * Browser-side user override for {@link defaultEVSettings}. Settings UI
 * writes here; new Connectors call `getDefaultEVSettings()` so they pick
 * up the user's preferred default at construction time.
 *
 * In the Bun daemon this stays null — the daemon process doesn't have
 * localStorage and the override is a per-user-browser concept.
 */
let userDefaultEVSettings: EVSettings | null = null;

export function getDefaultEVSettings(): EVSettings {
  return userDefaultEVSettings
    ? { ...userDefaultEVSettings }
    : { ...defaultEVSettings };
}

export function setUserDefaultEVSettings(s: EVSettings | null): void {
  userDefaultEVSettings = s ? { ...s } : null;
}

export function getUserDefaultEVSettings(): EVSettings | null {
  return userDefaultEVSettings ? { ...userDefaultEVSettings } : null;
}

export const EV_PRESETS: Record<string, Partial<EVSettings>> = {
  "Tesla Model 3": { batteryCapacityKwh: 75, maxChargingPowerKw: 250 },
  "Tesla Model Y": { batteryCapacityKwh: 82, maxChargingPowerKw: 250 },
  "Tesla Model S": { batteryCapacityKwh: 100, maxChargingPowerKw: 250 },
  "Nissan Leaf (40kWh)": { batteryCapacityKwh: 40, maxChargingPowerKw: 50 },
  "Nissan Leaf (62kWh)": { batteryCapacityKwh: 62, maxChargingPowerKw: 100 },
  "BMW i4": { batteryCapacityKwh: 84, maxChargingPowerKw: 200 },
  "BMW iX": { batteryCapacityKwh: 112, maxChargingPowerKw: 200 },
  "Hyundai Ioniq 5": { batteryCapacityKwh: 77, maxChargingPowerKw: 350 },
  "Kia EV6": { batteryCapacityKwh: 77, maxChargingPowerKw: 350 },
  "Porsche Taycan": { batteryCapacityKwh: 93, maxChargingPowerKw: 270 },
  "Mercedes EQS": { batteryCapacityKwh: 108, maxChargingPowerKw: 200 },
  "Volkswagen ID.4": { batteryCapacityKwh: 82, maxChargingPowerKw: 175 },
  Custom: {},
};

/**
 * Calculate estimated charging time in minutes
 */
export function calculateChargingTimeMinutes(
  currentSoc: number,
  targetSoc: number,
  batteryCapacityKwh: number,
  chargingPowerKw: number,
): number {
  if (chargingPowerKw <= 0 || currentSoc >= targetSoc) {
    return 0;
  }
  const energyNeededKwh = ((targetSoc - currentSoc) / 100) * batteryCapacityKwh;
  return (energyNeededKwh / chargingPowerKw) * 60;
}

/**
 * Calculate current SoC based on energy delivered
 */
export function calculateCurrentSoc(
  initialSoc: number,
  energyDeliveredWh: number,
  batteryCapacityKwh: number,
): number {
  const energyDeliveredKwh = energyDeliveredWh / 1000;
  const socIncrease = (energyDeliveredKwh / batteryCapacityKwh) * 100;
  return Math.min(100, initialSoc + socIncrease);
}
