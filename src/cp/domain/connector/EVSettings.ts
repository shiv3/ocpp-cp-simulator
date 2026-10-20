import { withNormalizedChargingCurve } from "./ChargingCurve";

/** A point on the piecewise-linear charging curve. */
export interface ChargingCurvePoint {
  /** State of charge this point applies at, 0-100. */
  socPercent: number;
  /** Fraction of `maxChargingPowerKw` accepted there, 0-1. */
  powerFraction: number;
}

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
  /** `DC` has no reactive component; `AC` divides current by phases. */
  currentType?: "AC" | "DC";
  /** AC phases. 1 or 3; absent means 1. */
  phases?: 1 | 3;
  /** Phase-to-neutral volts. Absent means 230. */
  voltageV?: number;
  /** cos φ, AC only. Absent means 1 (unity). */
  powerFactor?: number;
  /**
   * Credit owed for third-party data in these settings (#458): set when a
   * vehicle profile imported from a catalog is applied, so the attribution
   * travels with the copied values — into a scenario and its export.
   */
  attribution?: DataAttribution[];
}

/** One source's credit, as its license requires it to be given. */
export interface DataAttribution {
  /** The catalog source the data comes from (`gaia`, `kilowatt`). */
  sourceId?: string;
  /** The attribution text the source asks for. */
  text: string;
  licenseName: string;
  licenseUrl: string;
  /** Adapted material must be shared under the same license (CC BY-SA). */
  shareAlike: boolean;
}

/**
 * The fields every EV settings object has. A patch may change them, never
 * remove them: settings without a battery or a maximum power describe no
 * vehicle.
 */
export const REQUIRED_EV_SETTINGS_FIELDS = [
  "modelName",
  "batteryCapacityKwh",
  "maxChargingPowerKw",
  "initialSoc",
  "targetSoc",
] as const satisfies readonly (keyof EVSettings)[];

type RequiredEvSettingsField = (typeof REQUIRED_EV_SETTINGS_FIELDS)[number];

// The list above is every non-optional field of EVSettings: a required field
// added to the interface fails to compile here until it is listed.
type UnlistedRequiredField = Exclude<
  {
    [K in keyof EVSettings]-?: undefined extends EVSettings[K] ? never : K;
  }[keyof EVSettings],
  RequiredEvSettingsField
>;
const REQUIRED_FIELDS_ARE_LISTED: [UnlistedRequiredField] extends [never]
  ? true
  : never = true;
void REQUIRED_FIELDS_ARE_LISTED;

/**
 * An EV settings write as a merge patch (JSON Merge Patch, RFC 7396): an
 * absent key keeps the current value and `null` removes it (#458). Removing
 * is how a vehicle without a curve or an electrical model replaces one that
 * has them; JSON drops `undefined`, so over the control plane only `null`
 * can say it. Only optional fields can be removed.
 */
export type EVSettingsPatch = {
  [K in RequiredEvSettingsField]?: EVSettings[K];
} & {
  [K in Exclude<keyof EVSettings, RequiredEvSettingsField>]?:
    EVSettings[K] | null;
};

/** A write that would remove a required field. Nothing of it is applied. */
export class InvalidEvSettingsPatchError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`${fields.join(", ")} cannot be removed`);
    this.name = "InvalidEvSettingsPatchError";
  }
}

/**
 * Refuses settings or a patch that set a required field to `null`. Checked
 * before anything is written, so a refused write changes nothing.
 */
export function assertRequiredFieldsKept(settings: object): void {
  const values = settings as Record<string, unknown>;
  const removed = REQUIRED_EV_SETTINGS_FIELDS.filter(
    (field) => values[field] === null,
  );
  if (removed.length > 0) throw new InvalidEvSettingsPatchError(removed);
}

/**
 * The settings without the keys a patch set to `null`. Applied where
 * settings are stored (the connector, the user's default), so a `null`
 * is never read back.
 */
export function withoutNulls<T extends object>(settings: T): T {
  if (!Object.values(settings).includes(null)) return settings;
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== null),
  ) as T;
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

/**
 * Normalized on write (#301). `getDefaultEVSettings()` is read straight into
 * a fresh `Connector`'s field initializer, which bypasses the `evSettings`
 * setter and its guard — so a `chargingCurve` restored from localStorage, or
 * saved from the Settings panel, has to be validated here or it reaches
 * `powerFractionAtSoc` on the first meter tick.
 */
export function setUserDefaultEVSettings(s: EVSettings | null): void {
  if (s) assertRequiredFieldsKept(s);
  userDefaultEVSettings = s
    ? withNormalizedChargingCurve(withoutNulls({ ...s }))
    : null;
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
