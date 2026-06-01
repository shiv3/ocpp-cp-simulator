import {
  ArrayConfigurationKey,
  ArrayConfigurationValue,
  BooleanConfigurationKey,
  BooleanConfigurationValue,
  Configuration,
  ConfigurationKey,
  ConfigurationKeys,
  ConfigurationKeyType,
  ConfigurationValue,
  ConfigurationValueType,
  IntegerConfigurationKey,
  IntegerConfigurationValue,
  StringConfigurationKey,
  StringConfigurationValue,
  defaultConfiguration,
} from "./Configuration";
import type { ChargePoint } from "./ChargePoint";

/**
 * Status returned from a ChangeConfiguration.req attempt. Mirrors
 * OCPP 1.6 §5.3 / §7.22 ConfigurationStatus.
 */
export type ConfigurationChangeStatus =
  | "Accepted"
  | "Rejected"
  | "RebootRequired"
  | "NotSupported";

/**
 * Subset of keys whose effects only take hold after a reboot. ChangeConfiguration
 * still stores the value (so subsequent GetConfiguration reports it), but the
 * live behaviour stays unchanged until the next BootNotification cycle.
 */
const REBOOT_REQUIRED_KEYS = new Set<string>([
  "ChargingScheduleMaxPeriods", // pre-allocated array sizes etc.
  // (Extend as additional reboot-sensitive keys are wired in.)
]);

/**
 * One-shot listener type used by `ConfigurationStore.onChange`. The store
 * fires it whenever a value mutates (via `set` or `applyMany`); the
 * subscriber is expected to push the new value into whichever subsystem
 * actually implements the behaviour (HeartbeatService, MeterValueScheduler,
 * …).
 */
export type ConfigurationChangeListener = (
  key: string,
  value: ConfigurationValueType,
) => void;

const STORAGE_KEY_PREFIX = "charge_point_config_";

/**
 * In-memory keyed store for OCPP standard Configuration Keys, with
 * localStorage persistence and listener fan-out. Replaces the previous
 * stateless `defaultConfiguration` function.
 *
 * Lookup is by canonical key name (e.g. `"HeartbeatInterval"`); the store
 * knows the type and `readonly` flag from the original `ConfigurationKey`
 * definitions in `ConfigurationKeys`.
 */
export class ConfigurationStore {
  private readonly values = new Map<string, ConfigurationValue>();
  private readonly listeners = new Set<ConfigurationChangeListener>();

  constructor(
    private readonly chargePointId: string,
    initial: Configuration,
  ) {
    for (const entry of initial) {
      this.values.set(entry.key.name, entry);
    }
    this.loadOverrides();
  }

  /** Build a store from the canonical defaults plus any persisted overrides. */
  static forChargePoint(cp: ChargePoint): ConfigurationStore {
    return new ConfigurationStore(cp.id, defaultConfiguration(cp));
  }

  /** All entries the store currently knows about (defaults + overrides). */
  all(): Configuration {
    return Array.from(this.values.values());
  }

  /** Return entries for the requested keys; missing keys are listed in `unknown`. */
  read(keys: string[]): { known: Configuration; unknown: string[] } {
    if (keys.length === 0) {
      return { known: this.all(), unknown: [] };
    }
    const known: Configuration = [];
    const unknown: string[] = [];
    for (const name of keys) {
      const entry = this.values.get(name);
      if (entry) {
        known.push(entry);
      } else {
        unknown.push(name);
      }
    }
    return { known, unknown };
  }

  /** Raw lookup. Returns `undefined` for unknown keys. */
  get(name: string): ConfigurationValue | undefined {
    return this.values.get(name);
  }

  /** Typed getters for the common shapes. Returns `undefined` when missing or wrong type. */
  getInteger(name: string): number | undefined {
    const entry = this.values.get(name);
    if (!entry || entry.key.type !== "integer") return undefined;
    return entry.value as number;
  }

  getBoolean(name: string): boolean | undefined {
    const entry = this.values.get(name);
    if (!entry || entry.key.type !== "boolean") return undefined;
    return entry.value as boolean;
  }

  getString(name: string): string | undefined {
    const entry = this.values.get(name);
    if (!entry || entry.key.type !== "string") return undefined;
    return entry.value as string;
  }

  getArray(name: string): string[] | undefined {
    const entry = this.values.get(name);
    if (!entry || entry.key.type !== "array") return undefined;
    return entry.value as string[];
  }

  /**
   * Apply a ChangeConfiguration.req: parses the string value into the key's
   * declared type, persists, fires listeners, and returns the spec-defined
   * status. Unknown keys → `NotSupported`. Readonly keys → `Rejected`.
   * Parse failures → `Rejected`.
   */
  applyChange(name: string, rawValue: string): ConfigurationChangeStatus {
    const entry = this.values.get(name);
    if (!entry) return "NotSupported";
    if (entry.key.readonly) return "Rejected";

    const parsed = parseValue(entry.key, rawValue);
    if (parsed === PARSE_FAILED) return "Rejected";

    const next = { key: entry.key, value: parsed } as ConfigurationValue;
    this.values.set(name, next);
    this.persistOverride(name, parsed);
    this.emit(name, parsed);

    return REBOOT_REQUIRED_KEYS.has(name) ? "RebootRequired" : "Accepted";
  }

  /** Subscribe to value changes. Returns an unsubscribe function. */
  onChange(listener: ConfigurationChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── persistence ─────────────────────────────────────────────────────────
  private storageKey(): string {
    return `${STORAGE_KEY_PREFIX}${this.chargePointId}`;
  }

  private loadOverrides(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return;
      const overrides = JSON.parse(raw) as Record<
        string,
        ConfigurationValueType
      >;
      for (const [name, value] of Object.entries(overrides)) {
        const entry = this.values.get(name);
        // Silently skip overrides for keys the current defaults don't know
        // about (e.g. obsolete keys from an older simulator version) and
        // readonly keys — both indicate operator error rather than a real
        // override.
        if (!entry || entry.key.readonly) continue;
        if (!isValueAssignable(entry.key, value)) continue;
        this.values.set(name, {
          key: entry.key,
          value,
        } as ConfigurationValue);
      }
    } catch (err) {
      console.error("Failed to load config overrides:", err);
    }
  }

  private persistOverride(name: string, value: ConfigurationValueType): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.storageKey());
      const overrides = raw
        ? (JSON.parse(raw) as Record<string, ConfigurationValueType>)
        : {};
      overrides[name] = value;
      localStorage.setItem(this.storageKey(), JSON.stringify(overrides));
    } catch (err) {
      console.error("Failed to persist config override:", err);
    }
  }

  private emit(name: string, value: ConfigurationValueType): void {
    for (const listener of this.listeners) {
      try {
        listener(name, value);
      } catch (err) {
        console.error(`Configuration listener for '${name}' threw:`, err);
      }
    }
  }
}

const PARSE_FAILED = Symbol("config-parse-failed");

/**
 * Parse the wire-format string into the declared key type. Returns the
 * sentinel `PARSE_FAILED` on bad input so callers can map to `Rejected`.
 */
function parseValue(
  key: ConfigurationKey,
  raw: string,
): ConfigurationValueType | typeof PARSE_FAILED {
  switch (key.type) {
    case "integer": {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return PARSE_FAILED;
      return n;
    }
    case "boolean": {
      const lower = raw.trim().toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      return PARSE_FAILED;
    }
    case "array": {
      // §5.3 specifies CSL for array-typed keys. Empty string = empty list.
      const trimmed = raw.trim();
      if (trimmed === "") return [];
      return trimmed.split(",").map((s) => s.trim());
    }
    case "string":
      return raw;
    default:
      return PARSE_FAILED;
  }
}

function isValueAssignable(
  key: ConfigurationKey,
  value: unknown,
): value is ConfigurationValueType {
  switch (key.type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

// Re-export commonly-used types so importers don't need two import sites.
// `ConfigurationKeys` is a runtime object so it goes through `export`; the
// rest are pure type aliases so they need `export type` under
// isolatedModules.
export { ConfigurationKeys };
export type {
  ConfigurationKey,
  ArrayConfigurationKey,
  BooleanConfigurationKey,
  IntegerConfigurationKey,
  StringConfigurationKey,
  ConfigurationKeyType,
  ConfigurationValue,
  ConfigurationValueType,
  IntegerConfigurationValue,
  StringConfigurationValue,
  BooleanConfigurationValue,
  ArrayConfigurationValue,
};
