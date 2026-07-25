import {
  type NetworkSimLayerConfig,
  type NetworkSimRule,
  type LatencyRule,
  type ManualDisconnectRule,
  type PeriodicDisconnectRule,
  NETWORK_SIM_LIMITS,
} from "../../../cp/infrastructure/transport/network-sim/config";

/**
 * Form-friendly representation of a single rule.
 * Actions are stored comma-separated for UI editing.
 */
export interface RuleFormEntry {
  id: string;
  type: "latency" | "manual-disconnect" | "periodic-disconnect";
  direction?: "upstream" | "downstream" | "both";
  actions?: string; // comma-separated, trimmed
  delayMs?: number;
  jitterMs?: number;
  reconnectDelayMs?: number;
  intervalMs?: number;
  intervalJitterMs?: number;
}

/**
 * Form state for a network simulation layer.
 * seed is stored as a string to allow user input validation.
 */
export interface LayerFormState {
  enabled: boolean;
  seed: string; // string for the input; parsed on convert to number
  rules: RuleFormEntry[];
}

/**
 * Classification of a per-CP rule entry in a layered form state.
 * - inherited: rule exists in global layer, not overridden in per-CP layer
 * - overridden: rule exists in both global and per-CP layers (non-null)
 * - disabled-inherited: rule exists in global, tombstoned (null) in per-CP
 * - local: rule exists in per-CP layer only
 */
export type RuleClassification =
  "inherited" | "overridden" | "disabled-inherited" | "local";

/**
 * Per-CP form entry extending RuleFormEntry with classification and tri-state enabled.
 * Tri-state enabled: undefined (inherit) / true (on) / false (off)
 */
export interface CpRuleFormEntry extends RuleFormEntry {
  classification: RuleClassification;
}

/**
 * Per-CP form state with tri-state enabled and classified rules.
 * enabled: undefined (inherit from global) / true (on) / false (off)
 */
export interface CpLayerFormState {
  enabled: boolean | undefined;
  seed: string;
  rules: CpRuleFormEntry[];
}

export const emptyLayerForm: LayerFormState = {
  enabled: false,
  seed: "1",
  rules: [],
};

/**
 * Convert a domain NetworkSimLayerConfig to form state for editing.
 * null config → emptyLayerForm.
 * actions array joined by ", ".
 */
export function layerConfigToForm(
  config: NetworkSimLayerConfig | null,
): LayerFormState {
  if (!config) {
    return { ...emptyLayerForm };
  }

  const rules: RuleFormEntry[] = [];

  for (const [id, rule] of Object.entries(config.rules)) {
    if (rule === null) {
      continue;
    }

    const entry: RuleFormEntry = { id, type: rule.type };

    if (rule.type === "latency") {
      const latency = rule as LatencyRule;
      if (latency.direction) entry.direction = latency.direction;
      if (latency.match?.actions) {
        entry.actions = latency.match.actions.join(", ");
      }
      entry.delayMs = latency.delayMs;
      if (latency.jitterMs !== undefined) {
        entry.jitterMs = latency.jitterMs;
      }
    } else if (rule.type === "manual-disconnect") {
      const manual = rule as ManualDisconnectRule;
      entry.reconnectDelayMs = manual.reconnectDelayMs;
    } else if (rule.type === "periodic-disconnect") {
      const periodic = rule as PeriodicDisconnectRule;
      entry.intervalMs = periodic.intervalMs;
      if (periodic.intervalJitterMs !== undefined) {
        entry.intervalJitterMs = periodic.intervalJitterMs;
      }
      entry.reconnectDelayMs = periodic.reconnectDelayMs;
    }

    rules.push(entry);
  }

  return {
    enabled: config.enabled ?? false,
    seed: String(config.seed ?? 1),
    rules,
  };
}

/**
 * Convert form state to domain config with validation.
 * Reject-only: never partial. Returns keyed field errors on failure.
 */
export function formToLayerConfig(
  form: LayerFormState,
):
  | { ok: true; config: NetworkSimLayerConfig }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  // Parse seed
  let seed: number | undefined;
  if (form.seed === "") {
    errors["seed"] = "Seed is required";
  } else {
    const parsed = Number(form.seed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4_294_967_295) {
      errors["seed"] = "Seed must be an integer from 0 to 4,294,967,295";
    } else {
      seed = parsed;
    }
  }

  // Check for duplicate rule IDs
  const seenIds = new Set<string>();
  for (let i = 0; i < form.rules.length; i += 1) {
    const rule = form.rules[i];
    if (!rule.id.trim()) {
      errors[`rules.${i}.id`] = "Rule ID cannot be empty";
    } else if (rule.id.length > NETWORK_SIM_LIMITS.maxIdLength) {
      errors[`rules.${i}.id`] =
        `Rule ID must be at most ${NETWORK_SIM_LIMITS.maxIdLength} characters`;
    } else if (seenIds.has(rule.id)) {
      errors[`rules.${i}.id`] = `Duplicate rule ID: "${rule.id}"`;
    } else {
      seenIds.add(rule.id);
    }
  }

  // Check rule count
  if (form.rules.length > NETWORK_SIM_LIMITS.maxRulesPerLayer) {
    errors["rules"] =
      `At most ${NETWORK_SIM_LIMITS.maxRulesPerLayer} rules are allowed`;
  }

  // Validate per-rule fields
  for (let i = 0; i < form.rules.length; i += 1) {
    const rule = form.rules[i];
    const prefix = `rules.${i}`;

    if (rule.type === "latency") {
      if (!rule.delayMs && rule.delayMs !== 0) {
        errors[`${prefix}.delayMs`] = "Delay is required";
      } else if (
        !Number.isInteger(rule.delayMs) ||
        rule.delayMs < 0 ||
        rule.delayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.delayMs`] =
          `Delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }

      if (rule.jitterMs !== undefined) {
        if (
          !Number.isInteger(rule.jitterMs) ||
          rule.jitterMs < 0 ||
          rule.jitterMs > NETWORK_SIM_LIMITS.maxDelayMs
        ) {
          errors[`${prefix}.jitterMs`] =
            `Jitter must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
        }
      }

      if (rule.actions !== undefined) {
        const actionList = rule.actions
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);

        if (actionList.length > 0) {
          if (actionList.length > NETWORK_SIM_LIMITS.maxActions) {
            errors[`${prefix}.actions`] =
              `At most ${NETWORK_SIM_LIMITS.maxActions} actions are allowed`;
          }

          for (let j = 0; j < actionList.length; j += 1) {
            const action = actionList[j];
            if (action.length > NETWORK_SIM_LIMITS.maxActionLength) {
              errors[`${prefix}.actions`] =
                `Each action must be at most ${NETWORK_SIM_LIMITS.maxActionLength} characters`;
              break;
            }
          }
        }
      }
    } else if (rule.type === "manual-disconnect") {
      if (!rule.reconnectDelayMs && rule.reconnectDelayMs !== 0) {
        errors[`${prefix}.reconnectDelayMs`] = "Reconnect delay is required";
      } else if (
        !Number.isInteger(rule.reconnectDelayMs) ||
        rule.reconnectDelayMs < 0 ||
        rule.reconnectDelayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.reconnectDelayMs`] =
          `Reconnect delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }
    } else if (rule.type === "periodic-disconnect") {
      if (!rule.intervalMs && rule.intervalMs !== 0) {
        errors[`${prefix}.intervalMs`] = "Interval is required";
      } else if (
        !Number.isInteger(rule.intervalMs) ||
        rule.intervalMs < 1 ||
        rule.intervalMs > 2_147_483_647
      ) {
        errors[`${prefix}.intervalMs`] = "Interval must be 1-2,147,483,647ms";
      }

      if (rule.intervalJitterMs !== undefined) {
        if (
          !Number.isInteger(rule.intervalJitterMs) ||
          rule.intervalJitterMs < 0 ||
          rule.intervalJitterMs > 2_147_483_647
        ) {
          errors[`${prefix}.intervalJitterMs`] =
            "Interval jitter must be 0-2,147,483,647ms";
        }
      }

      if (!rule.reconnectDelayMs && rule.reconnectDelayMs !== 0) {
        errors[`${prefix}.reconnectDelayMs`] = "Reconnect delay is required";
      } else if (
        !Number.isInteger(rule.reconnectDelayMs) ||
        rule.reconnectDelayMs < 0 ||
        rule.reconnectDelayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.reconnectDelayMs`] =
          `Reconnect delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }
    }
  }

  // If there are field-level errors, return them (reject-only)
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // Build domain config
  const rules: Record<string, NetworkSimRule | null> = {};

  for (const rule of form.rules) {
    if (rule.type === "latency") {
      const actionList = rule.actions
        ? rule.actions
            .split(",")
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
        : [];

      rules[rule.id] = {
        type: "latency",
        direction: rule.direction,
        match: actionList.length > 0 ? { actions: actionList } : undefined,
        delayMs: rule.delayMs!,
        jitterMs: rule.jitterMs,
      };
    } else if (rule.type === "manual-disconnect") {
      rules[rule.id] = {
        type: "manual-disconnect",
        reconnectDelayMs: rule.reconnectDelayMs!,
      };
    } else if (rule.type === "periodic-disconnect") {
      rules[rule.id] = {
        type: "periodic-disconnect",
        intervalMs: rule.intervalMs!,
        intervalJitterMs: rule.intervalJitterMs,
        reconnectDelayMs: rule.reconnectDelayMs!,
      };
    }
  }

  const config: NetworkSimLayerConfig = {
    enabled: form.enabled,
    seed,
    rules,
  };

  return { ok: true, config };
}

/**
 * Convert a per-CP layer config to per-CP form state with classifications.
 * Classifies each rule in (inheritedRuleIds ∪ perCpRuleIds) by its presence
 * in inherited vs per-CP layer.
 *
 * Tri-state enabled: undefined (inherit) / true (on) / false (off)
 *
 * @param perCpLayer - The per-CP layer (can be null = fully inherited)
 * @param inheritedRules - Rules from global layer keyed by id
 * @returns Form state with classified rules
 */
export function cpLayerToForm(
  perCpLayer: NetworkSimLayerConfig | null,
  inheritedRules: Record<string, NetworkSimRule>,
): CpLayerFormState {
  const inheritedIds = new Set(Object.keys(inheritedRules));
  const perCpIds = new Set(Object.keys(perCpLayer?.rules ?? {}));
  const allIds = new Set([...inheritedIds, ...perCpIds]);

  const rules: CpRuleFormEntry[] = [];

  for (const id of Array.from(allIds).sort()) {
    const inheritedRule = inheritedRules[id];
    const perCpRuleOrTombstone = perCpLayer?.rules[id];

    // A tombstone naming a rule the global layer no longer has is a harmless
    // no-op (spec §3): there is nothing to display or disable, so drop it —
    // the next save self-heals the stored layer.
    if (perCpRuleOrTombstone === null && inheritedRule === undefined) {
      continue;
    }

    let classification: RuleClassification;
    let rule: NetworkSimRule | null;

    if (perCpRuleOrTombstone === undefined) {
      // Only in inherited
      classification = "inherited";
      rule = inheritedRule;
    } else if (perCpRuleOrTombstone === null) {
      // Tombstone in per-CP (disabled inherited)
      classification = "disabled-inherited";
      rule = inheritedRule;
    } else if (inheritedRule) {
      // In both (overridden)
      classification = "overridden";
      rule = perCpRuleOrTombstone;
    } else {
      // Only in per-CP (local)
      classification = "local";
      rule = perCpRuleOrTombstone;
    }

    // Convert rule to form entry
    const entry: RuleFormEntry = { id, type: rule.type };

    if (rule.type === "latency") {
      const latency = rule as LatencyRule;
      if (latency.direction) entry.direction = latency.direction;
      if (latency.match?.actions) {
        entry.actions = latency.match.actions.join(", ");
      }
      entry.delayMs = latency.delayMs;
      if (latency.jitterMs !== undefined) {
        entry.jitterMs = latency.jitterMs;
      }
    } else if (rule.type === "manual-disconnect") {
      const manual = rule as ManualDisconnectRule;
      entry.reconnectDelayMs = manual.reconnectDelayMs;
    } else if (rule.type === "periodic-disconnect") {
      const periodic = rule as PeriodicDisconnectRule;
      entry.intervalMs = periodic.intervalMs;
      if (periodic.intervalJitterMs !== undefined) {
        entry.intervalJitterMs = periodic.intervalJitterMs;
      }
      entry.reconnectDelayMs = periodic.reconnectDelayMs;
    }

    rules.push({ ...entry, classification });
  }

  return {
    enabled: perCpLayer?.enabled,
    seed: String(perCpLayer?.seed ?? 1),
    rules,
  };
}

/**
 * Convert per-CP form state to domain config with validation.
 * Only validates EDITABLE entries (overridden and local).
 * Inherited and disabled-inherited rows are read-only and not validated.
 * Reject-only: returns keyed field errors on failure.
 *
 * On success, produces a Record containing:
 * - Overridden entries as updated rules
 * - Disabled entries as null tombstones
 * - Local entries as new rules
 * - Inherited entries are omitted (layer inheritance)
 *
 * @param form - The per-CP form state
 * @returns { ok: true; config } or { ok: false; errors }
 */
export function formToCpLayer(
  form: CpLayerFormState,
):
  | { ok: true; config: NetworkSimLayerConfig | null }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  // Map rules with their original indices, then filter to only editable entries
  const editableRulesWithIndex = form.rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        rule.classification === "overridden" || rule.classification === "local",
    );

  // Check for duplicate rule IDs among editable rules
  const seenIds = new Set<string>();
  for (const { rule, index } of editableRulesWithIndex) {
    if (!rule.id.trim()) {
      errors[`rules.${index}.id`] = "Rule ID cannot be empty";
    } else if (rule.id.length > NETWORK_SIM_LIMITS.maxIdLength) {
      errors[`rules.${index}.id`] =
        `Rule ID must be at most ${NETWORK_SIM_LIMITS.maxIdLength} characters`;
    } else if (seenIds.has(rule.id)) {
      errors[`rules.${index}.id`] = `Duplicate rule ID: "${rule.id}"`;
    } else {
      seenIds.add(rule.id);
    }
  }

  // Check rule count (editable only)
  if (editableRulesWithIndex.length > NETWORK_SIM_LIMITS.maxRulesPerLayer) {
    errors["rules"] =
      `At most ${NETWORK_SIM_LIMITS.maxRulesPerLayer} rules are allowed`;
  }

  // Validate per-rule fields (only for editable rules)
  for (const { rule, index } of editableRulesWithIndex) {
    const prefix = `rules.${index}`;

    if (rule.type === "latency") {
      if (!rule.delayMs && rule.delayMs !== 0) {
        errors[`${prefix}.delayMs`] = "Delay is required";
      } else if (
        !Number.isInteger(rule.delayMs) ||
        rule.delayMs < 0 ||
        rule.delayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.delayMs`] =
          `Delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }

      if (rule.jitterMs !== undefined) {
        if (
          !Number.isInteger(rule.jitterMs) ||
          rule.jitterMs < 0 ||
          rule.jitterMs > NETWORK_SIM_LIMITS.maxDelayMs
        ) {
          errors[`${prefix}.jitterMs`] =
            `Jitter must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
        }
      }

      if (rule.actions !== undefined) {
        const actionList = rule.actions
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);

        if (actionList.length > 0) {
          if (actionList.length > NETWORK_SIM_LIMITS.maxActions) {
            errors[`${prefix}.actions`] =
              `At most ${NETWORK_SIM_LIMITS.maxActions} actions are allowed`;
          }

          for (let j = 0; j < actionList.length; j += 1) {
            const action = actionList[j];
            if (action.length > NETWORK_SIM_LIMITS.maxActionLength) {
              errors[`${prefix}.actions`] =
                `Each action must be at most ${NETWORK_SIM_LIMITS.maxActionLength} characters`;
              break;
            }
          }
        }
      }
    } else if (rule.type === "manual-disconnect") {
      if (!rule.reconnectDelayMs && rule.reconnectDelayMs !== 0) {
        errors[`${prefix}.reconnectDelayMs`] = "Reconnect delay is required";
      } else if (
        !Number.isInteger(rule.reconnectDelayMs) ||
        rule.reconnectDelayMs < 0 ||
        rule.reconnectDelayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.reconnectDelayMs`] =
          `Reconnect delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }
    } else if (rule.type === "periodic-disconnect") {
      if (!rule.intervalMs && rule.intervalMs !== 0) {
        errors[`${prefix}.intervalMs`] = "Interval is required";
      } else if (
        !Number.isInteger(rule.intervalMs) ||
        rule.intervalMs < 1 ||
        rule.intervalMs > 2_147_483_647
      ) {
        errors[`${prefix}.intervalMs`] = "Interval must be 1-2,147,483,647ms";
      }

      if (rule.intervalJitterMs !== undefined) {
        if (
          !Number.isInteger(rule.intervalJitterMs) ||
          rule.intervalJitterMs < 0 ||
          rule.intervalJitterMs > 2_147_483_647
        ) {
          errors[`${prefix}.intervalJitterMs`] =
            "Interval jitter must be 0-2,147,483,647ms";
        }
      }

      if (!rule.reconnectDelayMs && rule.reconnectDelayMs !== 0) {
        errors[`${prefix}.reconnectDelayMs`] = "Reconnect delay is required";
      } else if (
        !Number.isInteger(rule.reconnectDelayMs) ||
        rule.reconnectDelayMs < 0 ||
        rule.reconnectDelayMs > NETWORK_SIM_LIMITS.maxDelayMs
      ) {
        errors[`${prefix}.reconnectDelayMs`] =
          `Reconnect delay must be 0-${NETWORK_SIM_LIMITS.maxDelayMs}ms`;
      }
    }
  }

  // If there are field-level errors, return them (reject-only)
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // Build per-CP layer config with overrides, tombstones, and locals
  const rules: Record<string, NetworkSimRule | null> = {};

  for (const { rule } of editableRulesWithIndex) {
    // Handle rules marked for deletion (null in form)
    // In this form, deleted rules are simply not included in editable rules
    // Tombstones are managed by keeping null entries in perCpLayer

    if (rule.type === "latency") {
      const actionList = rule.actions
        ? rule.actions
            .split(",")
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
        : [];

      rules[rule.id] = {
        type: "latency",
        direction: rule.direction,
        match: actionList.length > 0 ? { actions: actionList } : undefined,
        delayMs: rule.delayMs!,
        jitterMs: rule.jitterMs,
      };
    } else if (rule.type === "manual-disconnect") {
      rules[rule.id] = {
        type: "manual-disconnect",
        reconnectDelayMs: rule.reconnectDelayMs!,
      };
    } else if (rule.type === "periodic-disconnect") {
      rules[rule.id] = {
        type: "periodic-disconnect",
        intervalMs: rule.intervalMs!,
        intervalJitterMs: rule.intervalJitterMs,
        reconnectDelayMs: rule.reconnectDelayMs!,
      };
    }
  }

  // Add tombstones for disabled entries
  for (const rule of form.rules) {
    if (rule.classification === "disabled-inherited") {
      rules[rule.id] = null;
    }
  }

  // If no editable changes and no tri-state enabled change, return null (full inheritance)
  const hasChanges =
    Object.keys(rules).length > 0 || form.enabled !== undefined;

  if (!hasChanges) {
    return { ok: true, config: null };
  }

  const config: NetworkSimLayerConfig = {
    enabled: form.enabled,
    rules,
  };

  return { ok: true, config };
}
