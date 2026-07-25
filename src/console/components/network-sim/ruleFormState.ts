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
