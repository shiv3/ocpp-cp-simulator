import { deriveSeed32 } from "./SeededRng";

export const MAX_TIMER_MS = 2_147_483_647;

export const NETWORK_SIM_LIMITS = {
  maxRulesPerLayer: 32,
  maxSerializedBytes: 65_536,
  maxSnapshotDepth: 8,
  maxSnapshotNodes: 4_096,
  maxResolvedRules: 64,
  maxIdLength: 64,
  maxActions: 64,
  maxActionLength: 64,
  maxDelayMs: 120_000,
} as const;

export interface NetworkSimLayerConfig {
  enabled?: boolean;
  seed?: number;
  rules: Record<string, NetworkSimRule | null>;
}

export interface LatencyRule {
  type: "latency";
  direction?: "upstream" | "downstream" | "both";
  match?: { actions: string[] };
  delayMs: number;
  jitterMs?: number;
}

export interface ManualDisconnectRule {
  type: "manual-disconnect";
  reconnectDelayMs: number;
}

export interface PeriodicDisconnectRule {
  type: "periodic-disconnect";
  intervalMs: number;
  intervalJitterMs?: number;
  reconnectDelayMs: number;
}

export type NetworkSimRule =
  LatencyRule | ManualDisconnectRule | PeriodicDisconnectRule;

export interface ResolvedNetworkSimConfig {
  enabled: boolean;
  seed: number;
  rules: Record<string, NetworkSimRule>;
}

export type ValidationResult =
  { ok: true; config: NetworkSimLayerConfig } | { ok: false; errors: string[] };

const FORBIDDEN_RULE_IDS = new Set(["__proto__", "constructor", "prototype"]);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nullRecord = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

const rejectUnknownFields = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }
};

const parseInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  errors: string[],
): number | undefined => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    errors.push(
      `${path}: expected a finite integer from ${minimum} to ${maximum}`,
    );
    return undefined;
  }

  return value;
};

const parseMatch = (
  value: unknown,
  path: string,
  errors: string[],
): { actions: string[] } | undefined => {
  if (!isPlainRecord(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }

  rejectUnknownFields(value, new Set(["actions"]), path, errors);
  const parsed = nullRecord<unknown>() as { actions?: string[] };
  const actions = hasOwn(value, "actions") ? value.actions : undefined;

  if (!Array.isArray(actions)) {
    errors.push(`${path}.actions: expected an array`);
    return undefined;
  }
  if (actions.length === 0 || actions.length > NETWORK_SIM_LIMITS.maxActions) {
    errors.push(
      `${path}.actions: expected 1 to ${NETWORK_SIM_LIMITS.maxActions} entries`,
    );
  }

  const parsedActions: string[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = hasOwn(actions, String(index)) ? actions[index] : undefined;
    if (
      typeof action !== "string" ||
      action.length === 0 ||
      action.length > NETWORK_SIM_LIMITS.maxActionLength
    ) {
      errors.push(
        `${path}.actions[${index}]: expected a non-empty string of at most ${NETWORK_SIM_LIMITS.maxActionLength} characters`,
      );
      continue;
    }
    parsedActions.push(action);
  }
  parsed.actions = parsedActions;

  return parsed as { actions: string[] };
};

const parseLatencyRule = (
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): LatencyRule => {
  rejectUnknownFields(
    value,
    new Set(["type", "direction", "match", "delayMs", "jitterMs"]),
    path,
    errors,
  );
  const parsed = nullRecord<unknown>() as unknown as LatencyRule;
  parsed.type = "latency";

  const delayMs = parseInteger(
    hasOwn(value, "delayMs") ? value.delayMs : undefined,
    `${path}.delayMs`,
    0,
    NETWORK_SIM_LIMITS.maxDelayMs,
    errors,
  );
  if (delayMs !== undefined) {
    parsed.delayMs = delayMs;
  }

  if (hasOwn(value, "jitterMs")) {
    const jitterMs = parseInteger(
      value.jitterMs,
      `${path}.jitterMs`,
      0,
      NETWORK_SIM_LIMITS.maxDelayMs,
      errors,
    );
    if (jitterMs !== undefined) {
      parsed.jitterMs = jitterMs;
    }
  }

  if (hasOwn(value, "direction")) {
    if (
      value.direction !== "upstream" &&
      value.direction !== "downstream" &&
      value.direction !== "both"
    ) {
      errors.push(
        `${path}.direction: expected "upstream", "downstream", or "both"`,
      );
    } else {
      parsed.direction = value.direction;
    }
  }

  if (hasOwn(value, "match")) {
    const match = parseMatch(value.match, `${path}.match`, errors);
    if (match !== undefined) {
      parsed.match = match;
    }
  }

  return parsed;
};

const parseManualDisconnectRule = (
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): ManualDisconnectRule => {
  rejectUnknownFields(
    value,
    new Set(["type", "reconnectDelayMs"]),
    path,
    errors,
  );
  const parsed = nullRecord<unknown>() as unknown as ManualDisconnectRule;
  parsed.type = "manual-disconnect";
  const reconnectDelayMs = parseInteger(
    hasOwn(value, "reconnectDelayMs") ? value.reconnectDelayMs : undefined,
    `${path}.reconnectDelayMs`,
    0,
    NETWORK_SIM_LIMITS.maxDelayMs,
    errors,
  );
  if (reconnectDelayMs !== undefined) {
    parsed.reconnectDelayMs = reconnectDelayMs;
  }
  return parsed;
};

const parsePeriodicDisconnectRule = (
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): PeriodicDisconnectRule => {
  rejectUnknownFields(
    value,
    new Set(["type", "intervalMs", "intervalJitterMs", "reconnectDelayMs"]),
    path,
    errors,
  );
  const parsed = nullRecord<unknown>() as unknown as PeriodicDisconnectRule;
  parsed.type = "periodic-disconnect";

  const intervalMs = parseInteger(
    hasOwn(value, "intervalMs") ? value.intervalMs : undefined,
    `${path}.intervalMs`,
    1,
    MAX_TIMER_MS,
    errors,
  );
  if (intervalMs !== undefined) {
    parsed.intervalMs = intervalMs;
  }

  if (hasOwn(value, "intervalJitterMs")) {
    const intervalJitterMs = parseInteger(
      value.intervalJitterMs,
      `${path}.intervalJitterMs`,
      0,
      MAX_TIMER_MS,
      errors,
    );
    if (intervalJitterMs !== undefined) {
      parsed.intervalJitterMs = intervalJitterMs;
    }
  }

  const reconnectDelayMs = parseInteger(
    hasOwn(value, "reconnectDelayMs") ? value.reconnectDelayMs : undefined,
    `${path}.reconnectDelayMs`,
    0,
    NETWORK_SIM_LIMITS.maxDelayMs,
    errors,
  );
  if (reconnectDelayMs !== undefined) {
    parsed.reconnectDelayMs = reconnectDelayMs;
  }

  return parsed;
};

const parseRule = (
  value: unknown,
  path: string,
  errors: string[],
): NetworkSimRule | null | undefined => {
  if (value === null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    errors.push(`${path}: expected a rule object or null`);
    return undefined;
  }

  const type = hasOwn(value, "type") ? value.type : undefined;
  switch (type) {
    case "latency":
      return parseLatencyRule(value, path, errors);
    case "manual-disconnect":
      return parseManualDisconnectRule(value, path, errors);
    case "periodic-disconnect":
      return parsePeriodicDisconnectRule(value, path, errors);
    default:
      errors.push(
        `${path}.type: expected "latency", "manual-disconnect", or "periodic-disconnect"`,
      );
      rejectUnknownFields(value, new Set(["type"]), path, errors);
      return undefined;
  }
};

class SnapshotError extends Error {}

interface SnapshotEntry {
  clone: unknown;
  serializedBytes?: number;
}

interface SnapshotBudget {
  nodes: number;
  serializedBytes: number;
  seen: WeakMap<object, SnapshotEntry>;
  errors: string[];
}

interface SnapshotValue {
  emitted: boolean;
  value: unknown;
}

const addSnapshotBytes = (budget: SnapshotBudget, bytes: number): void => {
  budget.serializedBytes += bytes;
  if (budget.serializedBytes > NETWORK_SIM_LIMITS.maxSerializedBytes) {
    throw new SnapshotError(
      `config serialized form exceeds ${NETWORK_SIM_LIMITS.maxSerializedBytes} UTF-8 bytes`,
    );
  }
};

const addSnapshotNode = (budget: SnapshotBudget): void => {
  budget.nodes += 1;
  if (budget.nodes > NETWORK_SIM_LIMITS.maxSnapshotNodes) {
    throw new SnapshotError(
      `config snapshot exceeds ${NETWORK_SIM_LIMITS.maxSnapshotNodes} nodes`,
    );
  }
};

const addJsonStringBytes = (value: string, budget: SnapshotBudget): void => {
  addSnapshotBytes(budget, 1);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      addSnapshotBytes(budget, 2);
    } else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      addSnapshotBytes(budget, 2);
    } else if (codeUnit <= 0x1f) {
      addSnapshotBytes(budget, 6);
    } else if (codeUnit <= 0x7f) {
      addSnapshotBytes(budget, 1);
    } else if (codeUnit <= 0x7ff) {
      addSnapshotBytes(budget, 2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        addSnapshotBytes(budget, 4);
        index += 1;
      } else {
        addSnapshotBytes(budget, 6);
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      addSnapshotBytes(budget, 6);
    } else {
      addSnapshotBytes(budget, 3);
    }
  }
  addSnapshotBytes(budget, 1);
};

const addPrimitiveJsonBytes = (
  value: unknown,
  budget: SnapshotBudget,
  path: string,
): void => {
  if (typeof value === "string") {
    addJsonStringBytes(value, budget);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      budget.errors.push(`${path}: non-finite numbers are not allowed`);
      addSnapshotBytes(budget, 4);
      return;
    }
    const token = String(Object.is(value, -0) ? 0 : value);
    addSnapshotBytes(budget, token.length);
  } else if (typeof value === "boolean") {
    addSnapshotBytes(budget, value ? 4 : 5);
  } else if (value === null) {
    addSnapshotBytes(budget, 4);
  } else {
    throw new SnapshotError(
      `${path}: config serialized form contains an invalid ${typeof value} value`,
    );
  }
};

const snapshotOwnSerializableValue = (
  value: unknown,
  budget: SnapshotBudget,
  path: string,
  depth: number,
): SnapshotValue => {
  if (depth > NETWORK_SIM_LIMITS.maxSnapshotDepth) {
    throw new SnapshotError(
      `${path}: snapshot nesting exceeds depth ${NETWORK_SIM_LIMITS.maxSnapshotDepth}`,
    );
  }
  if (typeof value === "function") {
    throw new SnapshotError(`${path}: functions are not allowed`);
  }
  if (typeof value !== "object" || value === null) {
    addSnapshotNode(budget);
    addPrimitiveJsonBytes(value, budget, path);
    return {
      emitted: true,
      value,
    };
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype)
  ) {
    throw new SnapshotError(`${path}: expected a plain JSON object or array`);
  }

  const existing = budget.seen.get(value);
  if (existing !== undefined) {
    if (existing.serializedBytes === undefined) {
      throw new SnapshotError(
        `${path}: config serialized form is invalid (cyclic reference)`,
      );
    }
    addSnapshotBytes(budget, existing.serializedBytes);
    return { emitted: true, value: existing.clone };
  }
  addSnapshotNode(budget);

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > NETWORK_SIM_LIMITS.maxSnapshotNodes - budget.nodes) {
    throw new SnapshotError(
      `config snapshot exceeds ${NETWORK_SIM_LIMITS.maxSnapshotNodes} nodes`,
    );
  }
  const getOwnDataDescriptor = (key: string | symbol) => {
    const propertyPath =
      isArray && typeof key === "string" && key !== "length"
        ? `${path}[${key}]`
        : `${path}.${String(key)}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      throw new SnapshotError(`${propertyPath}: property changed while read`);
    }
    if (typeof key === "symbol") {
      throw new SnapshotError(
        `${propertyPath}: symbol properties are not allowed`,
      );
    }
    if (!("value" in descriptor)) {
      throw new SnapshotError(
        `${propertyPath}: accessor properties are not allowed`,
      );
    }
    if (!descriptor.enumerable && !(isArray && key === "length")) {
      throw new SnapshotError(
        `${propertyPath}: non-enumerable properties are not allowed`,
      );
    }
    return descriptor;
  };

  if (isArray) {
    const lengthDescriptor = getOwnDataDescriptor("length");
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > NETWORK_SIM_LIMITS.maxActions
    ) {
      throw new SnapshotError(
        `${path}.length: arrays may contain at most ${NETWORK_SIM_LIMITS.maxActions} entries`,
      );
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new SnapshotError(
          `${path}[${index}]: sparse arrays are not allowed`,
        );
      }
    }
    for (const key of ownKeys) {
      getOwnDataDescriptor(key);
      if (typeof key !== "string") {
        throw new SnapshotError(
          `${path}.${String(key)}: symbol properties are not allowed`,
        );
      }
      if (key === "length") {
        continue;
      }
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= length ||
        String(index) !== key
      ) {
        throw new SnapshotError(
          `${path}.${key}: non-index array properties are not allowed`,
        );
      }
    }

    const clone: unknown[] = [];
    Object.defineProperty(clone, "toJSON", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    const entry: SnapshotEntry = { clone };
    budget.seen.set(value, entry);
    const serializedStart = budget.serializedBytes;
    addSnapshotBytes(budget, 1);
    for (let index = 0; index < length; index += 1) {
      if (index > 0) {
        addSnapshotBytes(budget, 1);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new SnapshotError(
          `${path}[${index}]: property changed while read`,
        );
      }
      const child = snapshotOwnSerializableValue(
        descriptor.value,
        budget,
        `${path}[${index}]`,
        depth + 1,
      );
      Object.defineProperty(clone, String(index), {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
    addSnapshotBytes(budget, 1);
    entry.serializedBytes = budget.serializedBytes - serializedStart;
    entry.clone = Object.freeze(clone);
    return { emitted: true, value: entry.clone };
  }

  for (const key of ownKeys) {
    getOwnDataDescriptor(key);
  }
  const clone = nullRecord<unknown>();
  const entry: SnapshotEntry = { clone };
  budget.seen.set(value, entry);
  const serializedStart = budget.serializedBytes;
  let emittedProperties = 0;
  addSnapshotBytes(budget, 1);
  for (const key of ownKeys) {
    const descriptor = getOwnDataDescriptor(key);
    if (typeof key !== "string") {
      throw new SnapshotError(
        `${path}.${String(key)}: symbol properties are not allowed`,
      );
    }
    if (emittedProperties > 0) {
      addSnapshotBytes(budget, 1);
    }
    addJsonStringBytes(key, budget);
    addSnapshotBytes(budget, 1);
    emittedProperties += 1;
    const child = snapshotOwnSerializableValue(
      descriptor.value,
      budget,
      `${path}.${key}`,
      depth + 1,
    );
    clone[key] = child.value;
  }
  addSnapshotBytes(budget, 1);
  entry.serializedBytes = budget.serializedBytes - serializedStart;
  entry.clone = Object.freeze(clone);
  return { emitted: true, value: entry.clone };
};

const validateSerializedSize = (value: unknown, errors: string[]): void => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      errors.push("config serialized form is unavailable");
      return;
    }
    if (
      new TextEncoder().encode(serialized).byteLength >
      NETWORK_SIM_LIMITS.maxSerializedBytes
    ) {
      errors.push(
        `config serialized form exceeds ${NETWORK_SIM_LIMITS.maxSerializedBytes} UTF-8 bytes`,
      );
    }
  } catch {
    errors.push("config serialized form is invalid");
  }
};

export function validateLayerConfig(value: unknown): ValidationResult {
  const errors: string[] = [];
  let snapshot: unknown;
  try {
    const budget: SnapshotBudget = {
      nodes: 0,
      serializedBytes: 0,
      seen: new WeakMap(),
      errors,
    };
    snapshot = snapshotOwnSerializableValue(value, budget, "config", 0).value;
  } catch (error) {
    errors.push(
      error instanceof SnapshotError
        ? error.message
        : "config snapshot could not be created",
    );
    return { ok: false, errors };
  }

  validateSerializedSize(snapshot, errors);

  if (!isPlainRecord(snapshot)) {
    errors.push("config: expected an object");
    return { ok: false, errors };
  }

  rejectUnknownFields(
    snapshot,
    new Set(["enabled", "seed", "rules"]),
    "config",
    errors,
  );
  const parsed = nullRecord<unknown>() as unknown as NetworkSimLayerConfig;

  if (hasOwn(snapshot, "enabled")) {
    if (typeof snapshot.enabled !== "boolean") {
      errors.push("config.enabled: expected a boolean");
    } else {
      parsed.enabled = snapshot.enabled;
    }
  }

  if (hasOwn(snapshot, "seed")) {
    const seed = parseInteger(
      snapshot.seed,
      "config.seed",
      0,
      4_294_967_295,
      errors,
    );
    if (seed !== undefined) {
      parsed.seed = seed;
    }
  }

  const rules = nullRecord<NetworkSimRule | null>();
  parsed.rules = rules;
  if (!hasOwn(snapshot, "rules")) {
    errors.push("config.rules: required");
  } else if (!isPlainRecord(snapshot.rules)) {
    errors.push("config.rules: expected an object");
  } else {
    const ruleIds = Object.keys(snapshot.rules);
    if (ruleIds.length > NETWORK_SIM_LIMITS.maxRulesPerLayer) {
      errors.push(
        `config.rules: at most ${NETWORK_SIM_LIMITS.maxRulesPerLayer} rules are allowed`,
      );
    }

    for (const ruleId of ruleIds) {
      const path = `config.rules.${ruleId}`;
      if (
        ruleId.length === 0 ||
        ruleId.length > NETWORK_SIM_LIMITS.maxIdLength
      ) {
        errors.push(
          `${path}: rule id must be non-empty and at most ${NETWORK_SIM_LIMITS.maxIdLength} characters`,
        );
      }
      if (FORBIDDEN_RULE_IDS.has(ruleId)) {
        errors.push(`${path}: forbidden rule id`);
      }

      const rule = parseRule(snapshot.rules[ruleId], path, errors);
      if (rule !== undefined) {
        rules[ruleId] = rule;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config: parsed };
}

export function resolveNetworkSimConfig(
  globalLayer: NetworkSimLayerConfig | null,
  perCharger: NetworkSimLayerConfig | null,
  chargePointId: string,
): ResolvedNetworkSimConfig {
  const rules = nullRecord<NetworkSimRule>();

  if (globalLayer !== null) {
    for (const ruleId of Object.keys(globalLayer.rules)) {
      const rule = globalLayer.rules[ruleId];
      if (rule !== null) {
        rules[ruleId] = rule;
      }
    }
  }

  if (perCharger !== null) {
    for (const ruleId of Object.keys(perCharger.rules)) {
      const rule = perCharger.rules[ruleId];
      if (rule === null) {
        delete rules[ruleId];
      } else {
        rules[ruleId] = rule;
      }
    }
  }

  const resolvedRuleCount = Object.keys(rules).length;
  if (resolvedRuleCount > NETWORK_SIM_LIMITS.maxResolvedRules) {
    throw new Error(
      `Resolved network simulation config exceeds the ${NETWORK_SIM_LIMITS.maxResolvedRules}-rule invariant`,
    );
  }

  const globalSeed = globalLayer?.seed ?? 1;
  const resolved = nullRecord<unknown>() as unknown as ResolvedNetworkSimConfig;
  resolved.enabled = perCharger?.enabled ?? globalLayer?.enabled ?? false;
  resolved.seed = perCharger?.seed ?? deriveSeed32(globalSeed, chargePointId);
  resolved.rules = rules;
  return resolved;
}
