// Direct read / write access to a running charge point's OCPP configuration
// keys (#612) -- the operator's counterpart of ChangeConfiguration /
// SetVariables. One value, one validation and one persistence path: writes go
// through `ConfigurationStore.applyChange`, exactly like the CSMS-driven ones.
//
// A key is addressed by its ConfigurationStore name. For OCPP 1.6 that is the
// 1.6 key; for 2.x the Device Model registry (#604) says which keys exist,
// whether they are writable (OCPP 2.0.1 Part 2 §2.1.4 mutability) and under
// which component / variable they appear. A 2.x store key without a registry
// entry is not part of the station's Device Model: it is neither listed nor
// writable (#569: acceptance implies implemented behavior).
import { DEVICE_MODEL } from "../device-model/DeviceModelRegistry";
import { LogType, type Logger } from "../../shared/Logger";
import { REDACTED_VALUE } from "../../shared/redaction";
import {
  isWriteOnlyConfigurationKey,
  type ConfigurationStore,
  type ConfigurationValue,
} from "./ConfigurationStore";

export type ConfigurationKeyMutability = "ReadOnly" | "ReadWrite" | "WriteOnly";

/** One configuration key as the control plane reports it. */
export interface ConfigurationKeyInfo {
  readonly key: string;
  /** Rendered as OCPP does: a list is comma-separated. Empty for a write-only key. */
  readonly value: string;
  readonly type: "string" | "integer" | "boolean" | "array";
  readonly readonly: boolean;
  /** 2.x only: the Device Model name behind the key. */
  readonly component?: string;
  readonly variable?: string;
  readonly instance?: string;
  /** Always set on 2.x; on 1.6 only `WriteOnly` (`AuthorizationKey`). */
  readonly mutability?: ConfigurationKeyMutability;
}

/**
 * Longest value a write accepts: a 1.6 `KeyValue.value` is a CiString500
 * (OCPP 1.6 ed2 §7.29) and a 2.x `attributeValue` a string of 1000, so a
 * longer value would stay stored but break the next GetConfiguration /
 * GetVariables answer.
 */
export const MAX_CONFIGURATION_VALUE_LENGTH = { v16: 500, v2: 1000 } as const;

export type ConfigurationSetStatus = "Accepted" | "RebootRequired";

export interface ConfigurationKeyList {
  readonly keys: readonly ConfigurationKeyInfo[];
  /**
   * Requested names the charge point has no such key for (and, on 2.x, no
   * Device Model variable). Empty when no name was requested.
   */
  readonly unknown: readonly string[];
}

/** The key is not one this charge point has (and, for 2.x, registers). */
export class UnknownConfigurationKeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown configuration key: ${key}`);
    this.name = "UnknownConfigurationKeyError";
  }
}

/** The key exists but its value cannot be written, or the value is refused (including a value over the length limit). */
export class ConfigurationWriteRejectedError extends Error {
  constructor(
    readonly key: string,
    readonly reason: "read_only" | "invalid_value",
  ) {
    super(
      reason === "read_only"
        ? `configuration key ${key} is read-only`
        : `invalid value for configuration key ${key}`,
    );
    this.name = "ConfigurationWriteRejectedError";
  }
}

function render(entry: ConfigurationValue): string {
  if (isWriteOnlyConfigurationKey(entry.key)) return "";
  const v = entry.value;
  return Array.isArray(v) ? v.join(",") : String(v);
}

function describe(
  entry: ConfigurationValue,
  is2x: boolean,
): ConfigurationKeyInfo | null {
  const base = {
    key: entry.key.name,
    value: render(entry),
    type: entry.key.type,
    readonly: entry.key.readonly,
  } as const;
  // The 1.6 flag set has no write-only; the store's rule (`AuthorizationKey`)
  // is reported the way 2.x does so a client can hide the value.
  if (!is2x) {
    return isWriteOnlyConfigurationKey(entry.key)
      ? { ...base, mutability: "WriteOnly" }
      : base;
  }
  const def = DEVICE_MODEL.byValueKey(entry.key.name);
  if (!def) return null;
  return {
    ...base,
    // The registry decides in 2.x; a pinned test keeps it equal to the flag.
    readonly: def.mutability === "ReadOnly",
    component: def.component,
    variable: def.variable,
    ...(def.instance === undefined ? {} : { instance: def.instance }),
    mutability: def.mutability,
  };
}

/** The keys named (all when `keys` is empty or absent), sorted by name. */
export function readConfigurationKeys(
  store: ConfigurationStore,
  is2x: boolean,
  keys: readonly string[] = [],
): ConfigurationKeyList {
  const { known, unknown } = store.read([...keys]);
  const infos: ConfigurationKeyInfo[] = [];
  const missing = [...unknown];
  for (const entry of known) {
    const info = describe(entry, is2x);
    if (info) infos.push(info);
    // A key outside the Device Model is "unknown" only when it was asked for;
    // a full read lists what is registered and nothing else.
    else if (keys.length > 0) missing.push(entry.key.name);
  }
  infos.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { keys: infos, unknown: missing };
}

/**
 * Write one key. Throws {@link UnknownConfigurationKeyError} for a key the
 * charge point does not have, {@link ConfigurationWriteRejectedError} for a
 * read-only key or a value the key refuses (type, bounds, allowed values).
 * On 2.x the caller passes `accepts`, the SetVariables value checks
 * (`configurationWriteCheckV201`), which the store alone does not run.
 */
export function writeConfigurationKey(
  store: ConfigurationStore,
  is2x: boolean,
  key: string,
  value: string,
  logger?: Logger,
  accepts?: (key: string, value: string) => boolean,
): ConfigurationSetStatus {
  const entry = store.get(key);
  if (!entry) throw new UnknownConfigurationKeyError(key);
  const info = describe(entry, is2x);
  if (!info) throw new UnknownConfigurationKeyError(key);
  if (info.readonly || info.mutability === "ReadOnly") {
    throw new ConfigurationWriteRejectedError(key, "read_only");
  }
  const limit = is2x
    ? MAX_CONFIGURATION_VALUE_LENGTH.v2
    : MAX_CONFIGURATION_VALUE_LENGTH.v16;
  if (value.length > limit || (accepts && !accepts(key, value))) {
    throw new ConfigurationWriteRejectedError(key, "invalid_value");
  }
  const status = store.applyChange(key, value);
  // The CSMS-driven writes are logged; so is this one, or a changed
  // HeartbeatInterval could not be explained from the log.
  logger?.info(
    `Operator set ${key}='${
      store.isWriteOnly(key) ? REDACTED_VALUE : value
    }' → ${status}`,
    LogType.CONFIGURATION,
  );
  if (status === "Accepted" || status === "RebootRequired") return status;
  throw new ConfigurationWriteRejectedError(
    key,
    entry.key.readonly ? "read_only" : "invalid_value",
  );
}
