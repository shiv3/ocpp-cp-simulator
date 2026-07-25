import { describe, expect, it } from "vitest";

import {
  type LayerFormState,
  type CpLayerFormState,
  type RuleFormEntry,
  emptyLayerForm,
  layerConfigToForm,
  formToLayerConfig,
  cpLayerToForm,
  formToCpLayer,
} from "../ruleFormState";
import { validateLayerConfig } from "../../../../cp/infrastructure/transport/network-sim/config";
import type {
  NetworkSimLayerConfig,
  LatencyRule,
  ManualDisconnectRule,
  PeriodicDisconnectRule,
} from "../../../../cp/infrastructure/transport/network-sim/config";

describe("ruleFormState", () => {
  describe("layerConfigToForm", () => {
    it("converts null config to emptyLayerForm", () => {
      const form = layerConfigToForm(null);
      expect(form).toEqual(emptyLayerForm);
    });

    it("converts a latency rule with all fields", () => {
      const config: NetworkSimLayerConfig = {
        enabled: true,
        seed: 42,
        rules: {
          "rule-1": {
            type: "latency",
            direction: "upstream",
            match: { actions: ["BootNotification", "StatusNotification"] },
            delayMs: 100,
            jitterMs: 50,
          } as LatencyRule,
        },
      };

      const form = layerConfigToForm(config);

      expect(form.enabled).toBe(true);
      expect(form.seed).toBe("42");
      expect(form.rules).toHaveLength(1);
      expect(form.rules[0]).toEqual({
        id: "rule-1",
        type: "latency",
        direction: "upstream",
        actions: "BootNotification, StatusNotification",
        delayMs: 100,
        jitterMs: 50,
      });
    });

    it("converts a manual-disconnect rule", () => {
      const config: NetworkSimLayerConfig = {
        enabled: false,
        seed: 1,
        rules: {
          "disconnect-1": {
            type: "manual-disconnect",
            reconnectDelayMs: 5000,
          } as ManualDisconnectRule,
        },
      };

      const form = layerConfigToForm(config);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0]).toEqual({
        id: "disconnect-1",
        type: "manual-disconnect",
        reconnectDelayMs: 5000,
      });
    });

    it("converts a periodic-disconnect rule", () => {
      const config: NetworkSimLayerConfig = {
        enabled: true,
        seed: 1,
        rules: {
          "periodic-1": {
            type: "periodic-disconnect",
            intervalMs: 30000,
            intervalJitterMs: 5000,
            reconnectDelayMs: 2000,
          } as PeriodicDisconnectRule,
        },
      };

      const form = layerConfigToForm(config);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0]).toEqual({
        id: "periodic-1",
        type: "periodic-disconnect",
        intervalMs: 30000,
        intervalJitterMs: 5000,
        reconnectDelayMs: 2000,
      });
    });

    it("skips null rules in config", () => {
      const config: NetworkSimLayerConfig = {
        enabled: true,
        seed: 1,
        rules: {
          "rule-1": { type: "latency", delayMs: 100 } as LatencyRule,
          "deleted-rule": null,
        },
      };

      const form = layerConfigToForm(config);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0].id).toBe("rule-1");
    });

    it("defaults enabled to false and seed to '1' if not provided", () => {
      const config: NetworkSimLayerConfig = {
        rules: {
          "rule-1": { type: "latency", delayMs: 100 } as LatencyRule,
        },
      };

      const form = layerConfigToForm(config);

      expect(form.enabled).toBe(false);
      expect(form.seed).toBe("1");
    });
  });

  describe("formToLayerConfig - successful conversion", () => {
    it("converts a valid latency rule round-trip", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "42",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            direction: "downstream",
            actions: "BootNotification, StatusNotification",
            delayMs: 150,
            jitterMs: 25,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const config = result.config;
        expect(config.enabled).toBe(true);
        expect(config.seed).toBe(42);
        expect(config.rules["rule-1"]).toEqual({
          type: "latency",
          direction: "downstream",
          match: { actions: ["BootNotification", "StatusNotification"] },
          delayMs: 150,
          jitterMs: 25,
        });
      }
    });

    it("converts a valid manual-disconnect rule", () => {
      const form: LayerFormState = {
        enabled: false,
        seed: "1",
        rules: [
          {
            id: "disconnect-1",
            type: "manual-disconnect",
            reconnectDelayMs: 3000,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.rules["disconnect-1"]).toEqual({
          type: "manual-disconnect",
          reconnectDelayMs: 3000,
        });
      }
    });

    it("converts a valid periodic-disconnect rule", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "100",
        rules: [
          {
            id: "periodic-1",
            type: "periodic-disconnect",
            intervalMs: 20000,
            intervalJitterMs: 3000,
            reconnectDelayMs: 1500,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.rules["periodic-1"]).toEqual({
          type: "periodic-disconnect",
          intervalMs: 20000,
          intervalJitterMs: 3000,
          reconnectDelayMs: 1500,
        });
      }
    });

    it("trims and filters empty actions from comma-separated list", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            actions: "  BootNotification  , , StatusNotification  ",
            delayMs: 50,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const match = (result.config.rules["rule-1"] as LatencyRule).match;
        expect(match?.actions).toEqual([
          "BootNotification",
          "StatusNotification",
        ]);
      }
    });

    it("handles optional fields not provided", () => {
      const form: LayerFormState = {
        enabled: false,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            delayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const rule = result.config.rules["rule-1"] as LatencyRule;
        expect(rule.direction).toBeUndefined();
        expect(rule.match).toBeUndefined();
        expect(rule.jitterMs).toBeUndefined();
      }
    });
  });

  describe("formToLayerConfig - validation errors", () => {
    it("rejects invalid seed (not an integer)", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "not-a-number",
        rules: [],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["seed"]).toBeDefined();
        expect(result.errors["seed"]).toContain("integer");
      }
    });

    it("rejects seed out of range (> 4,294,967,295)", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "4294967296", // one past max
        rules: [],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["seed"]).toBeDefined();
      }
    });

    it("rejects empty rule id", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "",
            type: "latency",
            delayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.id"]).toBeDefined();
      }
    });

    it("rejects rule id exceeding max length", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "a".repeat(65), // exceeds max of 64
            type: "latency",
            delayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.id"]).toBeDefined();
      }
    });

    it("rejects duplicate rule ids", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            delayMs: 100,
          },
          {
            id: "rule-1", // duplicate
            type: "latency",
            delayMs: 50,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.1.id"]).toContain("Duplicate");
      }
    });

    it("rejects too many rules (> 32)", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: Array.from({ length: 33 }, (_, i) => ({
          id: `rule-${i}`,
          type: "latency" as const,
          delayMs: 100,
        })),
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules"]).toBeDefined();
      }
    });

    it("rejects latency rule with missing delay", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.delayMs"]).toBeDefined();
      }
    });

    it("rejects latency delay exceeding max (120000ms)", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            delayMs: 120001,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.delayMs"]).toBeDefined();
      }
    });

    it("rejects jitter exceeding max", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            delayMs: 100,
            jitterMs: 120001,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.jitterMs"]).toBeDefined();
      }
    });

    it("rejects action list with too many entries", () => {
      const actions = Array.from({ length: 65 }, (_, i) => `action${i}`).join(
        ", ",
      );
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            actions,
            delayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.actions"]).toBeDefined();
      }
    });

    it("rejects action exceeding max length", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "latency",
            actions: "a".repeat(65), // exceeds max of 64
            delayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.actions"]).toBeDefined();
      }
    });

    it("rejects periodic-disconnect with interval < 1", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "periodic-disconnect",
            intervalMs: 0,
            reconnectDelayMs: 100,
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.intervalMs"]).toBeDefined();
      }
    });

    it("rejects manual-disconnect with missing reconnect delay", () => {
      const form: LayerFormState = {
        enabled: true,
        seed: "1",
        rules: [
          {
            id: "rule-1",
            type: "manual-disconnect",
          },
        ],
      };

      const result = formToLayerConfig(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.reconnectDelayMs"]).toBeDefined();
      }
    });
  });

  describe("round-trip", () => {
    it("converts config → form → config stable for all rule types", () => {
      const config: NetworkSimLayerConfig = {
        enabled: true,
        seed: 42,
        rules: {
          "latency-1": {
            type: "latency",
            direction: "both",
            match: { actions: ["BootNotification"] },
            delayMs: 100,
            jitterMs: 20,
          } as LatencyRule,
          "manual-1": {
            type: "manual-disconnect",
            reconnectDelayMs: 5000,
          } as ManualDisconnectRule,
          "periodic-1": {
            type: "periodic-disconnect",
            intervalMs: 30000,
            intervalJitterMs: 5000,
            reconnectDelayMs: 2000,
          } as PeriodicDisconnectRule,
        },
      };

      const form = layerConfigToForm(config);
      const result = formToLayerConfig(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config).toEqual(config);
      }
    });
  });
});

describe("Per-CP layer form state (cpLayerToForm, formToCpLayer)", () => {
  describe("cpLayerToForm", () => {
    it("classifies inherited rules (in global, not in per-CP)", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };

      const form = cpLayerToForm(null, inheritedRules);

      expect(form.enabled).toBeUndefined();
      expect(form.rules).toHaveLength(1);
      expect(form.rules[0].id).toBe("g-latency");
      expect(form.rules[0].classification).toBe("inherited");
    });

    it("classifies overridden rules (in both, non-null)", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "g-latency": {
            type: "latency",
            delayMs: 200,
          } as LatencyRule,
        },
      };

      const form = cpLayerToForm(perCpLayer, inheritedRules);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0].classification).toBe("overridden");
      expect(form.rules[0].delayMs).toBe(200);
    });

    it("classifies disabled-inherited rules (null tombstone in per-CP)", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "g-latency": null,
        },
      };

      const form = cpLayerToForm(perCpLayer, inheritedRules);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0].classification).toBe("disabled-inherited");
    });

    it("classifies local rules (in per-CP only)", () => {
      const inheritedRules: Record<string, LatencyRule> = {};
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "local-rule": {
            type: "latency",
            delayMs: 50,
          } as LatencyRule,
        },
      };

      const form = cpLayerToForm(perCpLayer, inheritedRules);

      expect(form.rules).toHaveLength(1);
      expect(form.rules[0].id).toBe("local-rule");
      expect(form.rules[0].classification).toBe("local");
    });

    it("tri-state enabled: undefined (inherit)", () => {
      const form = cpLayerToForm(null, {});
      expect(form.enabled).toBeUndefined();
    });

    it("tri-state enabled: true (on)", () => {
      const perCpLayer: NetworkSimLayerConfig = {
        enabled: true,
        rules: {},
      };
      const form = cpLayerToForm(perCpLayer, {});
      expect(form.enabled).toBe(true);
    });

    it("includes mixed classifications in output", () => {
      const baseInheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "g-latency": {
            type: "latency",
            delayMs: 200,
          } as LatencyRule,
          "local-rule": {
            type: "latency",
            delayMs: 50,
          } as LatencyRule,
        },
      };
      const form = cpLayerToForm(perCpLayer, baseInheritedRules);

      expect(form.rules).toHaveLength(2);
      const overridden = form.rules.find((r) => r.id === "g-latency");
      const local = form.rules.find((r) => r.id === "local-rule");

      expect(overridden?.classification).toBe("overridden");
      expect(local?.classification).toBe("local");
    });

    it("tri-state enabled: false (off)", () => {
      const perCpLayer: NetworkSimLayerConfig = {
        enabled: false,
        rules: {},
      };
      const form = cpLayerToForm(perCpLayer, {});
      expect(form.enabled).toBe(false);
    });

    it("drops a tombstone whose inherited rule no longer exists (spec §3 no-op)", () => {
      // The global layer dropped "gone-from-global" after the CP disabled it.
      const perCpLayer: NetworkSimLayerConfig = {
        rules: { "gone-from-global": null },
      };
      const form = cpLayerToForm(perCpLayer, {});
      expect(form.rules).toHaveLength(0);
    });
  });

  describe("formToCpLayer", () => {
    it("returns null config when no editable changes and enabled undefined", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const form = cpLayerToForm(null, inheritedRules);
      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config).toBeNull();
      }
    });

    it("includes overridden rules in output", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "g-latency": {
            type: "latency",
            delayMs: 200,
          } as LatencyRule,
        },
      };
      const form = cpLayerToForm(perCpLayer, inheritedRules);
      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const config = result.config;
        expect(config).not.toBeNull();
        expect(config!.rules["g-latency"]).toEqual({
          type: "latency",
          delayMs: 200,
        });
      }
    });

    it("includes disabled (null tombstone) rules in output", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "g-latency": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "g-latency": null,
        },
      };
      const form = cpLayerToForm(perCpLayer, inheritedRules);
      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const config = result.config;
        expect(config).not.toBeNull();
        expect(config!.rules["g-latency"]).toBeNull();
      }
    });

    it("includes local rules in output", () => {
      const inheritedRules: Record<string, LatencyRule> = {};
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "local-rule": {
            type: "latency",
            delayMs: 50,
          } as LatencyRule,
        },
      };
      const form = cpLayerToForm(perCpLayer, inheritedRules);
      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const config = result.config;
        expect(config).not.toBeNull();
        expect(config!.rules["local-rule"]).toEqual({
          type: "latency",
          delayMs: 50,
        });
      }
    });

    it("validates only editable (overridden/local) rules", () => {
      const form: CpLayerFormState = {
        enabled: undefined,
        seed: "1",
        rules: [
          {
            id: "g-latency",
            type: "latency",
            delayMs: -1, // invalid
            classification: "inherited",
          },
        ],
      };

      const result = formToCpLayer(form);

      // Inherited rule should not be validated
      expect(result.ok).toBe(true);
    });

    it("rejects invalid editable rule", () => {
      const form: CpLayerFormState = {
        enabled: undefined,
        seed: "1",
        rules: [
          {
            id: "local-rule",
            type: "latency",
            delayMs: -1, // invalid
            classification: "local",
          },
        ],
      };

      const result = formToCpLayer(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.delayMs"]).toBeDefined();
      }
    });

    it("supports tri-state enabled in output config", () => {
      const form: CpLayerFormState = {
        enabled: true,
        seed: "1",
        rules: [],
      };

      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config).not.toBeNull();
        expect(result.config!.enabled).toBe(true);
      }
    });

    it("per-CP config has NO seed key (seed is derived per-charger)", () => {
      const form: CpLayerFormState = {
        enabled: true,
        seed: "123",
        rules: [
          {
            id: "local-rule",
            type: "latency",
            delayMs: 50,
            classification: "local",
          },
        ],
      };

      const result = formToCpLayer(form);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config).not.toBeNull();
        expect(result.config!.seed).toBeUndefined();
      }
    });

    it("per-CP validation errors key to the correct row when inherited row precedes editable", () => {
      const inheritedRules: Record<string, LatencyRule> = {
        "inherited-1": {
          type: "latency",
          delayMs: 100,
        } as LatencyRule,
      };
      const perCpLayer: NetworkSimLayerConfig = {
        rules: {
          "inherited-1": {
            type: "latency",
            delayMs: 100,
          } as LatencyRule,
          "local-1": {
            type: "latency",
            delayMs: -1, // invalid
          } as LatencyRule,
        },
      };

      const form = cpLayerToForm(perCpLayer, inheritedRules);
      const result = formToCpLayer(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The error should key to the ACTUAL row index in form.rules, not filtered index
        // form.rules has: [inherited-1 (index 0), local-1 (index 1)]
        // Only local-1 is editable, but error should be at rules.1.delayMs
        const errorKey = Object.keys(result.errors).find((k) =>
          k.startsWith("rules."),
        );
        expect(errorKey).toBe("rules.1.delayMs");
      }
    });
  });
});

describe("form output survives the config validator", () => {
  // The editor's output goes straight to saveNetworkSimGlobal /
  // saveNetworkSimCp, which validate before applying. Asserting on the shape
  // alone missed that optional fields were emitted as explicit `undefined`,
  // which validateLayerConfig rejects — so a default latency rule could be
  // built by the form and then refused on save.
  const row = (over: Partial<RuleFormEntry> = {}): RuleFormEntry => ({
    id: "r1",
    type: "latency",
    delayMs: 100,
    ...over,
  });

  it("accepts a latency rule with every optional field left blank", () => {
    const result = formToLayerConfig({
      enabled: true,
      seed: "1",
      rules: [row()],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateLayerConfig(result.config).ok).toBe(true);
      expect("direction" in result.config.rules["r1"]!).toBe(false);
      expect("jitterMs" in result.config.rules["r1"]!).toBe(false);
    }
  });

  it("accepts a periodic-disconnect rule without jitter", () => {
    const result = formToLayerConfig({
      enabled: true,
      seed: "1",
      rules: [
        row({
          type: "periodic-disconnect",
          delayMs: undefined,
          intervalMs: 30000,
          reconnectDelayMs: 5000,
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateLayerConfig(result.config).ok).toBe(true);
    }
  });

  it("accepts a per-CP layer whose local rule leaves optionals blank", () => {
    const result = formToCpLayer({
      enabled: true,
      seed: "1",
      rules: [{ ...row(), classification: "local" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.config) {
      expect(validateLayerConfig(result.config).ok).toBe(true);
    }
  });
});
