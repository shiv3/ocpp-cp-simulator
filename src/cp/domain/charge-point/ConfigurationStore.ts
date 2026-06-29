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
import type { Database } from "../persistence/Database";

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
  "SecurityProfile", // transport profile changes require reconnect/reboot.
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

/**
 * In-memory keyed store for OCPP standard Configuration Keys, with
 * SQLite persistence (via the injected {@link Database}) and listener
 * fan-out. Replaces the previous stateless `defaultConfiguration`
 * function.
 *
 * Lookup is by canonical key name (e.g. `"HeartbeatInterval"`); the store
 * knows the type and `readonly` flag from the original `ConfigurationKey`
 * definitions in `ConfigurationKeys`.
 *
 * Overrides written via {@link applyChange} land in the `configuration`
 * table (`cp_id`, `key`, `value`). When `database` is null (legacy / test
 * path) the store stays in-memory only.
 */
export class ConfigurationStore {
  private readonly values = new Map<string, ConfigurationValue>();
  private readonly listeners = new Set<ConfigurationChangeListener>();

  constructor(
    private readonly chargePointId: string,
    initial: Configuration,
    private readonly database: Database | null = null,
  ) {
    for (const entry of initial) {
      this.values.set(entry.key.name, entry);
    }
    this.loadOverrides();
  }

  /** Build a store from the canonical defaults plus any persisted overrides. */
  static forChargePoint(
    cp: ChargePoint,
    database: Database | null = null,
  ): ConfigurationStore {
    return new ConfigurationStore(cp.id, defaultConfiguration(cp), database);
  }

  /** All entries the store currently knows about (defaults + overrides). */
  all(): Configuration {
    return Array.from(this.values.values());
  }

  /** Entries safe for read surfaces such as GetConfiguration and debug dumps. */
  allRedacted(): Configuration {
    return this.all().map(redactConfigurationValue);
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

  /** Read entries with write-only values blanked for OCPP/wire/debug output. */
  readRedacted(keys: string[]): { known: Configuration; unknown: string[] } {
    const { known, unknown } = this.read(keys);
    return { known: known.map(redactConfigurationValue), unknown };
  }

  /** JSON.stringify(ConfigurationStore) must not expose write-only values. */
  toJSON(): Configuration {
    return this.allRedacted();
  }

  /** Raw lookup. Returns `undefined` for unknown keys. */
  get(name: string): ConfigurationValue | undefined {
    return this.values.get(name);
  }

  isWriteOnly(name: string): boolean {
    const entry = this.values.get(name);
    return entry ? isWriteOnlyConfigurationKey(entry.key) : false;
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

  /** Canonical key `MeterValuesSampledData`; default `["Energy.Active.Import.Register"]`. */
  meterValuesSampledData(): string[] {
    return (
      this.getArray("MeterValuesSampledData") ?? [
        "Energy.Active.Import.Register",
      ]
    );
  }

  /** Canonical key `TransactionMessageAttempts`; default `3`. */
  transactionMessageAttempts(): number {
    return this.getInteger("TransactionMessageAttempts") ?? 3;
  }

  /** Canonical key `AuthorizeRemoteTxRequests`; default `false`. */
  authorizeRemoteTxRequests(): boolean {
    return this.getBoolean("AuthorizeRemoteTxRequests") ?? false;
  }

  /** Canonical key `LocalAuthListEnabled`; default `true`. */
  localAuthListEnabled(): boolean {
    return this.getBoolean("LocalAuthListEnabled") ?? true;
  }

  /** Canonical key `LocalAuthListMaxLength`; default `1000`. */
  localAuthListMaxLength(): number {
    return this.getInteger("LocalAuthListMaxLength") ?? 1000;
  }

  /** Canonical key `SendLocalListMaxLength`; default `100`. */
  sendLocalListMaxLength(): number {
    return this.getInteger("SendLocalListMaxLength") ?? 100;
  }

  /** Canonical key `ConnectionTimeOut`; default `60`. */
  connectionTimeOut(): number {
    return this.getInteger("ConnectionTimeOut") ?? 60;
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
    if (!isConfigurationValueValid(entry.key, parsed)) return "Rejected";

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

  private loadOverrides(): void {
    if (!this.database) return;
    try {
      const rows = this.database.all<{ key: string; value: string }>(
        "SELECT key, value FROM configuration WHERE cp_id = ?",
        [this.chargePointId],
      );
      for (const { key: name, value: raw } of rows) {
        const entry = this.values.get(name);
        // Silently skip overrides for keys the current defaults don't know
        // about (e.g. obsolete keys from an older simulator version) and
        // readonly keys — both indicate operator error rather than a real
        // override.
        if (!entry || entry.key.readonly) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          continue;
        }
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
    if (!this.database) return;
    try {
      this.database.run(
        "INSERT INTO configuration (cp_id, key, value) VALUES (?, ?, ?) " +
          "ON CONFLICT (cp_id, key) DO UPDATE SET value = excluded.value",
        [this.chargePointId, name, JSON.stringify(value)],
      );
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

function isConfigurationValueValid(
  key: ConfigurationKey,
  value: ConfigurationValueType,
): boolean {
  if (key.name === "SecurityProfile") {
    return typeof value === "number" && value >= 0 && value <= 3;
  }
  return true;
}

export function isWriteOnlyConfigurationKey(
  key: ConfigurationKey | string,
): boolean {
  if (typeof key === "string") return key === "AuthorizationKey";
  return key.writeonly === true || key.name === "AuthorizationKey";
}

export function redactConfigurationValue(
  entry: ConfigurationValue,
): ConfigurationValue {
  if (!isWriteOnlyConfigurationKey(entry.key)) return entry;
  return {
    key: entry.key,
    value: "",
  } as ConfigurationValue;
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
