export interface EVSettings {
  modelName: string; // EV名/モデル
  batteryCapacityKwh: number; // バッテリー容量 (kWh)
  maxChargingPowerKw: number; // 最大充電電力 (kW)
  initialSoc: number; // 初期SoC (%)
  targetSoc: number; // 目標SoC (%)
}

export const defaultEVSettings: EVSettings = {
  modelName: "Generic EV",
  batteryCapacityKwh: 75,
  maxChargingPowerKw: 150,
  initialSoc: 20,
  targetSoc: 80,
};

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
