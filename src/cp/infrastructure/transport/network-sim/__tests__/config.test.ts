import { describe, expect, it } from "vitest";

import { deriveSeed32 } from "../SeededRng";
import {
  MAX_TIMER_MS,
  NETWORK_SIM_LIMITS,
  resolveNetworkSimConfig,
  validateLayerConfig,
  type NetworkSimLayerConfig,
} from "../config";

const expectInvalid = (value: unknown, paths: string[] = []) => {
  const result = validateLayerConfig(value);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    for (const path of paths) {
      expect(result.errors.some((error) => error.includes(path))).toBe(true);
    }
  }
};

const expectValid = (value: unknown) => {
  const result = validateLayerConfig(value);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.config;
};

describe("validateLayerConfig", () => {
  it("parses a complete config into null-prototype objects", () => {
    const config = expectValid({
      enabled: true,
      seed: 4_294_967_295,
      rules: {
        latency: {
          type: "latency",
          direction: "both",
          match: { actions: ["BootNotification"] },
          delayMs: 120_000,
          jitterMs: 0,
        },
        manual: {
          type: "manual-disconnect",
          reconnectDelayMs: 120_000,
        },
        periodic: {
          type: "periodic-disconnect",
          intervalMs: MAX_TIMER_MS,
          intervalJitterMs: MAX_TIMER_MS,
          reconnectDelayMs: 0,
        },
        removed: null,
      },
    });

    expect(Object.getPrototypeOf(config)).toBeNull();
    expect(Object.getPrototypeOf(config.rules)).toBeNull();
    expect(Object.getPrototypeOf(config.rules.latency)).toBeNull();
    const latency = config.rules.latency;
    expect(latency?.type).toBe("latency");
    if (latency?.type === "latency") {
      expect(Object.getPrototypeOf(latency.match)).toBeNull();
    }
  });

  it("accepts every numeric lower and upper bound", () => {
    expectValid({
      seed: 0,
      rules: {
        latencyLower: { type: "latency", delayMs: 0, jitterMs: 0 },
        latencyUpper: {
          type: "latency",
          delayMs: NETWORK_SIM_LIMITS.maxDelayMs,
          jitterMs: NETWORK_SIM_LIMITS.maxDelayMs,
        },
        manualLower: {
          type: "manual-disconnect",
          reconnectDelayMs: 0,
        },
        manualUpper: {
          type: "manual-disconnect",
          reconnectDelayMs: NETWORK_SIM_LIMITS.maxDelayMs,
        },
        periodicLower: {
          type: "periodic-disconnect",
          intervalMs: 1,
          intervalJitterMs: 0,
          reconnectDelayMs: 0,
        },
        periodicUpper: {
          type: "periodic-disconnect",
          intervalMs: MAX_TIMER_MS,
          intervalJitterMs: MAX_TIMER_MS,
          reconnectDelayMs: NETWORK_SIM_LIMITS.maxDelayMs,
        },
      },
    });
    expectValid({ seed: 4_294_967_295, rules: {} });
  });

  it.each([
    ["seed below", { seed: -1, rules: {} }, "seed"],
    ["seed above", { seed: 4_294_967_296, rules: {} }, "seed"],
    [
      "delay below",
      { rules: { rule: { type: "latency", delayMs: -1 } } },
      "delayMs",
    ],
    [
      "delay above",
      { rules: { rule: { type: "latency", delayMs: 120_001 } } },
      "delayMs",
    ],
    [
      "jitter below",
      {
        rules: {
          rule: { type: "latency", delayMs: 0, jitterMs: -1 },
        },
      },
      "jitterMs",
    ],
    [
      "jitter above",
      {
        rules: {
          rule: { type: "latency", delayMs: 0, jitterMs: 120_001 },
        },
      },
      "jitterMs",
    ],
    [
      "reconnect below",
      {
        rules: {
          rule: { type: "manual-disconnect", reconnectDelayMs: -1 },
        },
      },
      "reconnectDelayMs",
    ],
    [
      "reconnect above",
      {
        rules: {
          rule: {
            type: "manual-disconnect",
            reconnectDelayMs: 120_001,
          },
        },
      },
      "reconnectDelayMs",
    ],
    [
      "interval below",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: 0,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalMs",
    ],
    [
      "interval above",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: MAX_TIMER_MS + 1,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalMs",
    ],
    [
      "interval jitter below",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: 1,
            intervalJitterMs: -1,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalJitterMs",
    ],
    [
      "interval jitter above",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: 1,
            intervalJitterMs: MAX_TIMER_MS + 1,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalJitterMs",
    ],
  ])("rejects the %s bound", (_name, value, path) => {
    expectInvalid(value, [path]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["a fraction", 1.5],
    ["a numeric string", "1"],
  ])("rejects %s for every numeric field", (_name, invalidNumber) => {
    expectInvalid(
      {
        seed: invalidNumber,
        rules: {
          latency: {
            type: "latency",
            delayMs: invalidNumber,
            jitterMs: invalidNumber,
          },
          manual: {
            type: "manual-disconnect",
            reconnectDelayMs: invalidNumber,
          },
          periodic: {
            type: "periodic-disconnect",
            intervalMs: invalidNumber,
            intervalJitterMs: invalidNumber,
            reconnectDelayMs: invalidNumber,
          },
        },
      },
      [
        "seed",
        "delayMs",
        "jitterMs",
        "reconnectDelayMs",
        "intervalMs",
        "intervalJitterMs",
      ],
    );
  });

  it.each([
    ["seed", { seed: -0, rules: {} }, "seed"],
    [
      "delayMs",
      { rules: { rule: { type: "latency", delayMs: -0 } } },
      "delayMs",
    ],
    [
      "jitterMs",
      {
        rules: {
          rule: { type: "latency", delayMs: 0, jitterMs: -0 },
        },
      },
      "jitterMs",
    ],
    [
      "reconnectDelayMs",
      {
        rules: {
          rule: { type: "manual-disconnect", reconnectDelayMs: -0 },
        },
      },
      "reconnectDelayMs",
    ],
    [
      "intervalMs",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: -0,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalMs",
    ],
    [
      "intervalJitterMs",
      {
        rules: {
          rule: {
            type: "periodic-disconnect",
            intervalMs: 1,
            intervalJitterMs: -0,
            reconnectDelayMs: 0,
          },
        },
      },
      "intervalJitterMs",
    ],
  ])("rejects negative zero for %s", (_name, value, path) => {
    expectInvalid(value, [path]);
  });

  describe("with a polluted Object.prototype", () => {
    it("ignores inherited rule discriminators", () => {
      const typeDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "type",
      );

      try {
        Object.defineProperty(Object.prototype, "type", {
          configurable: true,
          value: "latency",
        });

        expectInvalid(JSON.parse('{"rules":{"inherited":{}}}'), [
          "inherited.type",
        ]);
      } finally {
        if (typeDescriptor === undefined) {
          delete (Object.prototype as { type?: unknown }).type;
        } else {
          Object.defineProperty(Object.prototype, "type", typeDescriptor);
        }
      }
    });

    it("ignores an inherited latency delayMs", () => {
      const delayDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "delayMs",
      );

      try {
        Object.defineProperty(Object.prototype, "delayMs", {
          configurable: true,
          value: 7,
        });

        expectInvalid(
          {
            rules: {
              inherited: { type: "latency" },
            },
          },
          ["inherited.delayMs"],
        );
      } finally {
        if (delayDescriptor === undefined) {
          delete (Object.prototype as { delayMs?: unknown }).delayMs;
        } else {
          Object.defineProperty(Object.prototype, "delayMs", delayDescriptor);
        }
      }
    });

    it("ignores inherited required disconnect fields", () => {
      const intervalDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "intervalMs",
      );
      const reconnectDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "reconnectDelayMs",
      );

      try {
        Object.defineProperty(Object.prototype, "intervalMs", {
          configurable: true,
          value: 1,
        });
        Object.defineProperty(Object.prototype, "reconnectDelayMs", {
          configurable: true,
          value: 0,
        });

        expectInvalid(
          {
            rules: {
              manual: { type: "manual-disconnect" },
              periodic: { type: "periodic-disconnect" },
            },
          },
          [
            "manual.reconnectDelayMs",
            "periodic.intervalMs",
            "periodic.reconnectDelayMs",
          ],
        );
      } finally {
        if (intervalDescriptor === undefined) {
          delete (Object.prototype as { intervalMs?: unknown }).intervalMs;
        } else {
          Object.defineProperty(
            Object.prototype,
            "intervalMs",
            intervalDescriptor,
          );
        }
        if (reconnectDescriptor === undefined) {
          delete (Object.prototype as { reconnectDelayMs?: unknown })
            .reconnectDelayMs;
        } else {
          Object.defineProperty(
            Object.prototype,
            "reconnectDelayMs",
            reconnectDescriptor,
          );
        }
      }
    });

    it("ignores inherited match actions", () => {
      const actionsDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "actions",
      );

      try {
        Object.defineProperty(Object.prototype, "actions", {
          configurable: true,
          value: ["Heartbeat"],
        });

        expectInvalid(
          {
            rules: {
              latency: {
                type: "latency",
                delayMs: 0,
                match: {},
              },
            },
          },
          ["match.actions"],
        );
      } finally {
        if (actionsDescriptor === undefined) {
          delete (Object.prototype as { actions?: unknown }).actions;
        } else {
          Object.defineProperty(Object.prototype, "actions", actionsDescriptor);
        }
      }
    });
  });

  it.each([
    [
      "latency with disconnect fields",
      {
        type: "latency",
        delayMs: 0,
        intervalMs: 1,
        intervalJitterMs: 0,
        reconnectDelayMs: 0,
      },
      ["intervalMs", "intervalJitterMs", "reconnectDelayMs"],
    ],
    [
      "manual with latency and interval fields",
      {
        type: "manual-disconnect",
        reconnectDelayMs: 0,
        delayMs: 0,
        jitterMs: 0,
        direction: "both",
        match: { actions: ["Heartbeat"] },
        intervalMs: 1,
        intervalJitterMs: 0,
      },
      [
        "delayMs",
        "jitterMs",
        "direction",
        "match",
        "intervalMs",
        "intervalJitterMs",
      ],
    ],
    [
      "periodic with latency fields",
      {
        type: "periodic-disconnect",
        intervalMs: 1,
        reconnectDelayMs: 0,
        delayMs: 0,
        jitterMs: 0,
        direction: "upstream",
        match: { actions: ["Heartbeat"] },
      },
      ["delayMs", "jitterMs", "direction", "match"],
    ],
  ])("rejects %s", (_name, rule, paths) => {
    expectInvalid({ rules: { rule } }, paths);
  });

  it("enforces required fields for each union member", () => {
    expectInvalid(
      {
        rules: {
          latency: { type: "latency" },
          manual: { type: "manual-disconnect" },
          periodicInterval: {
            type: "periodic-disconnect",
            reconnectDelayMs: 0,
          },
          periodicReconnect: {
            type: "periodic-disconnect",
            intervalMs: 1,
          },
        },
      },
      [
        "rules.latency.delayMs",
        "rules.manual.reconnectDelayMs",
        "rules.periodicInterval.intervalMs",
        "rules.periodicReconnect.reconnectDelayMs",
      ],
    );
  });

  it("rejects invalid discriminators and directions", () => {
    expectInvalid(
      {
        rules: {
          missing: { delayMs: 0 },
          unknown: { type: "disconnect", reconnectDelayMs: 0 },
          direction: {
            type: "latency",
            direction: "sideways",
            delayMs: 0,
          },
        },
      },
      ["rules.missing.type", "rules.unknown.type", "direction"],
    );
  });

  it("rejects unknown fields at the config, rule, and match levels", () => {
    expectInvalid(
      {
        enabled: false,
        rules: {
          latency: {
            type: "latency",
            delayMs: 0,
            extraRuleField: true,
            match: {
              actions: ["Heartbeat"],
              extraMatchField: true,
            },
          },
        },
        extraConfigField: true,
      },
      ["extraConfigField", "extraRuleField", "extraMatchField"],
    );
  });

  it("requires plain objects and the rules field", () => {
    expectInvalid(null);
    expectInvalid([]);
    expectInvalid({});
    expectInvalid({ rules: [] }, ["rules"]);
    expectInvalid({ enabled: "true", rules: {} }, ["enabled"]);
    expectInvalid({ rules: { bad: "rule" } }, ["rules.bad"]);
  });

  it("enforces rule id constraints and rejects dangerous keys", () => {
    const dangerousRules = JSON.parse(
      '{"__proto__":null,"constructor":null,"prototype":null}',
    ) as unknown;

    expectValid({
      rules: {
        ["x".repeat(NETWORK_SIM_LIMITS.maxIdLength)]: null,
      },
    });
    expectInvalid({ rules: { "": null } }, ["rules"]);
    expectInvalid(
      { rules: { ["x".repeat(NETWORK_SIM_LIMITS.maxIdLength + 1)]: null } },
      ["rules"],
    );
    expectInvalid({ rules: dangerousRules }, [
      "__proto__",
      "constructor",
      "prototype",
    ]);
  });

  it("enforces match.actions constraints", () => {
    expectValid({
      rules: {
        exactLimits: {
          type: "latency",
          delayMs: 0,
          match: {
            actions: Array.from({ length: NETWORK_SIM_LIMITS.maxActions }, () =>
              "x".repeat(NETWORK_SIM_LIMITS.maxActionLength),
            ),
          },
        },
      },
    });
    expectInvalid(
      {
        rules: {
          notArray: {
            type: "latency",
            delayMs: 0,
            match: { actions: "Heartbeat" },
          },
          empty: {
            type: "latency",
            delayMs: 0,
            match: { actions: [] },
          },
          emptyAction: {
            type: "latency",
            delayMs: 0,
            match: { actions: [""] },
          },
          nonStringAction: {
            type: "latency",
            delayMs: 0,
            match: { actions: [42] },
          },
          longAction: {
            type: "latency",
            delayMs: 0,
            match: {
              actions: ["x".repeat(NETWORK_SIM_LIMITS.maxActionLength + 1)],
            },
          },
        },
      },
      [
        "notArray.match.actions",
        "empty.match.actions",
        "emptyAction.match.actions[0]",
        "nonStringAction.match.actions[0]",
        "longAction.match.actions[0]",
      ],
    );
    expectInvalid(
      {
        rules: {
          tooMany: {
            type: "latency",
            delayMs: 0,
            match: {
              actions: Array.from(
                { length: NETWORK_SIM_LIMITS.maxActions + 1 },
                () => "a",
              ),
            },
          },
        },
      },
      ["tooMany.match.actions.length"],
    );
  });

  it("accepts exactly 32 rules and rejects 33", () => {
    const makeRules = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`rule-${index}`, null]),
      );

    expectValid({ rules: makeRules(NETWORK_SIM_LIMITS.maxRulesPerLayer) });
    expectInvalid({
      rules: makeRules(NETWORK_SIM_LIMITS.maxRulesPerLayer + 1),
    });
  });

  it("accepts the maximal legal node shape with 32 rules and 64 actions each", () => {
    const rules = Object.fromEntries(
      Array.from(
        { length: NETWORK_SIM_LIMITS.maxRulesPerLayer },
        (_, ruleIndex) => [
          `rule-${ruleIndex}`,
          {
            type: "latency",
            direction: "both",
            match: {
              actions: Array.from(
                { length: NETWORK_SIM_LIMITS.maxActions },
                () => "a",
              ),
            },
            delayMs: NETWORK_SIM_LIMITS.maxDelayMs,
            jitterMs: NETWORK_SIM_LIMITS.maxDelayMs,
          },
        ],
      ),
    );

    expectValid({ enabled: true, seed: 4_294_967_295, rules });
  });

  it(
    "rejects a deeply shared DAG without expanding its serialization",
    { timeout: 1_000 },
    () => {
      let shared: Record<string, unknown> = { leaf: "x" };
      for (let depth = 0; depth < 30; depth += 1) {
        shared = { left: shared, right: shared };
      }

      expectInvalid({ rules: {}, unknown: shared }, ["snapshot nesting"]);
    },
  );

  it("re-counts shared children toward the running byte cap", () => {
    let shared: Record<string, unknown> = { leaf: "x".repeat(1_100) };
    for (let depth = 0; depth < 6; depth += 1) {
      shared = { left: shared, right: shared };
    }

    expectInvalid({ rules: {}, unknown: shared }, ["serialized"]);
  });

  it("rejects a deeply nested unique chain during the snapshot walk", () => {
    let chain: Record<string, unknown> = {};
    for (
      let depth = 0;
      depth <= NETWORK_SIM_LIMITS.maxSnapshotDepth;
      depth += 1
    ) {
      chain = { child: chain };
    }

    expectInvalid({ rules: {}, unknown: chain }, ["snapshot nesting"]);
  });

  it("rejects node-count overflow during the snapshot walk", () => {
    const nodes = Object.fromEntries(
      Array.from(
        { length: NETWORK_SIM_LIMITS.maxSnapshotNodes },
        (_, index) => [index.toString(36), {}],
      ),
    );

    expectInvalid({ rules: {}, unknown: nodes }, ["snapshot", "nodes"]);
  });

  it(
    "rejects a very wide object before scanning its property descriptors",
    { timeout: 2_000 },
    () => {
      const wide = Object.fromEntries(
        Array.from({ length: 200_000 }, (_, index) => [
          index.toString(36),
          null,
        ]),
      );
      let descriptorReads = 0;
      const observedWide = new Proxy(wide, {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const startedAt = performance.now();

      expectInvalid({ rules: {}, unknown: observedWide }, [
        "snapshot",
        "nodes",
      ]);

      expect(descriptorReads).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    },
  );

  it("measures the serialized cap in UTF-8 bytes near the boundary", () => {
    const rules = Object.fromEntries(
      Array.from(
        { length: NETWORK_SIM_LIMITS.maxRulesPerLayer },
        (_, ruleIndex) => [
          `rule-${ruleIndex}`,
          {
            type: "latency",
            delayMs: 0,
            match: {
              actions: Array.from(
                { length: NETWORK_SIM_LIMITS.maxActions },
                () => "a",
              ),
            },
          },
        ],
      ),
    );
    const withinLimit = { rules };
    const actions = Object.values(rules).flatMap((rule) =>
      rule.match.actions.map(
        (_, index) => [rule.match.actions, index] as const,
      ),
    );
    const encoder = new TextEncoder();

    outer: for (const [actionList, index] of actions) {
      while (actionList[index].length < NETWORK_SIM_LIMITS.maxActionLength) {
        actionList[index] += "界";
        if (
          encoder.encode(JSON.stringify(withinLimit)).byteLength >
          NETWORK_SIM_LIMITS.maxSerializedBytes
        ) {
          actionList[index] = actionList[index].slice(0, -1);
          break outer;
        }
      }
    }

    const withinBytes = encoder.encode(JSON.stringify(withinLimit)).byteLength;
    expect(withinBytes).toBeLessThanOrEqual(
      NETWORK_SIM_LIMITS.maxSerializedBytes,
    );
    expect(NETWORK_SIM_LIMITS.maxSerializedBytes - withinBytes).toBeLessThan(3);
    expectValid(withinLimit);

    const overLimit = structuredClone(withinLimit);
    overLimit.rules["rule-0"].match.actions[0] += "界";
    expect(
      encoder.encode(JSON.stringify(overLimit)).byteLength,
    ).toBeGreaterThan(NETWORK_SIM_LIMITS.maxSerializedBytes);
    expectInvalid(overLimit, ["serialized"]);
  });

  it("rejects a stateful own rules getter without invoking it", () => {
    let reads = 0;
    const oversizedRules = Object.fromEntries(
      Array.from(
        { length: NETWORK_SIM_LIMITS.maxRulesPerLayer },
        (_, ruleIndex) => [
          `rule-${ruleIndex}`,
          {
            type: "latency",
            delayMs: 0,
            match: {
              actions: Array.from(
                { length: NETWORK_SIM_LIMITS.maxActions },
                () => "x".repeat(NETWORK_SIM_LIMITS.maxActionLength),
              ),
            },
          },
        ],
      ),
    );
    const config = {
      get rules() {
        reads += 1;
        return reads === 1 ? {} : oversizedRules;
      },
    };

    expectInvalid(config, ["config.rules"]);
    expect(reads).toBe(0);
  });

  it("does not let an own toJSON getter shrink the measured size", () => {
    let reads = 0;
    const oversized = {
      rules: Object.fromEntries(
        Array.from(
          { length: NETWORK_SIM_LIMITS.maxRulesPerLayer },
          (_, ruleIndex) => [
            `rule-${ruleIndex}`,
            {
              type: "latency",
              delayMs: 0,
              match: {
                actions: Array.from(
                  { length: NETWORK_SIM_LIMITS.maxActions },
                  () => "x".repeat(NETWORK_SIM_LIMITS.maxActionLength),
                ),
              },
            },
          ],
        ),
      ),
    };
    Object.defineProperty(oversized, "toJSON", {
      configurable: true,
      get() {
        reads += 1;
        Reflect.deleteProperty(oversized, "toJSON");
        return () => ({});
      },
    });

    expectInvalid(oversized, ["config.toJSON"]);
    expect(reads).toBe(0);
  });

  it("rejects an accessor anywhere in the config without invoking it", () => {
    let invoked = false;
    const config = {
      rules: {
        latency: {
          type: "latency",
          delayMs: 0,
          match: {
            get actions() {
              invoked = true;
              return ["Heartbeat"];
            },
          },
        },
      },
    };

    expectInvalid(config, ["config.rules.latency.match.actions"]);
    expect(invoked).toBe(false);
  });

  it("rejects a nested accessor hidden beneath a non-enumerable property", () => {
    let invoked = false;
    const hidden = {
      get nested() {
        invoked = true;
        return {};
      },
    };
    const config = { rules: {} };
    Object.defineProperty(config, "hidden", {
      configurable: true,
      enumerable: false,
      value: hidden,
    });

    expectInvalid(config, ["config.hidden"]);
    expect(invoked).toBe(false);
  });

  it("rejects an accessor beneath a symbol-keyed property", () => {
    let invoked = false;
    const hidden = {
      get nested() {
        invoked = true;
        return {};
      },
    };
    const config = { rules: {} };
    Object.defineProperty(config, Symbol("hidden"), {
      configurable: true,
      enumerable: true,
      value: hidden,
    });

    expectInvalid(config, ["Symbol(hidden)"]);
    expect(invoked).toBe(false);
  });

  it("rejects a setter-only own property", () => {
    const config = {};
    Object.defineProperty(config, "rules", {
      configurable: true,
      enumerable: true,
      set(_value: unknown) {},
    });

    expectInvalid(config, ["config.rules"]);
  });

  it("rejects accessors at every config nesting level without invoking them", () => {
    const cases = [
      {
        path: "config.rules",
        makeValue: (markInvoked: () => void) => ({
          get rules() {
            markInvoked();
            return {};
          },
        }),
      },
      {
        path: "config.rules.latency",
        makeValue: (markInvoked: () => void) => ({
          rules: {
            get latency() {
              markInvoked();
              return null;
            },
          },
        }),
      },
      {
        path: "config.rules.latency.delayMs",
        makeValue: (markInvoked: () => void) => ({
          rules: {
            latency: {
              type: "latency",
              get delayMs() {
                markInvoked();
                return 0;
              },
            },
          },
        }),
      },
      {
        path: "config.rules.latency.match.actions",
        makeValue: (markInvoked: () => void) => ({
          rules: {
            latency: {
              type: "latency",
              delayMs: 0,
              match: {
                get actions() {
                  markInvoked();
                  return ["Heartbeat"];
                },
              },
            },
          },
        }),
      },
      {
        path: "config.rules.latency.match.actions[0]",
        makeValue: (markInvoked: () => void) => {
          const actions = ["Heartbeat"];
          Object.defineProperty(actions, "0", {
            configurable: true,
            enumerable: true,
            get() {
              markInvoked();
              return "Heartbeat";
            },
          });
          return {
            rules: {
              latency: {
                type: "latency",
                delayMs: 0,
                match: { actions },
              },
            },
          };
        },
      },
    ];

    for (const { path, makeValue } of cases) {
      let invoked = false;
      expectInvalid(
        makeValue(() => {
          invoked = true;
        }),
        [path],
      );
      expect(invoked).toBe(false);
    }
  });

  it("rejects sparse match.actions arrays", () => {
    const actions = ["Heartbeat"];
    delete actions[0];

    expectInvalid(
      {
        rules: {
          latency: {
            type: "latency",
            delayMs: 0,
            match: { actions },
          },
        },
      },
      ["actions[0]"],
    );
  });

  it("rejects huge match.actions lengths before allocation", () => {
    const actions: string[] = [];
    actions.length = 1_000_000_000;

    expectInvalid(
      {
        rules: {
          latency: {
            type: "latency",
            delayMs: 0,
            match: { actions },
          },
        },
      },
      ["actions.length"],
    );
  });

  it("does not observe inherited numeric getters for array holes", () => {
    const indexDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "0",
    );
    let observed = false;
    let result: ReturnType<typeof validateLayerConfig>;

    try {
      Object.defineProperty(Object.prototype, "0", {
        configurable: true,
        get() {
          observed = true;
          return "inherited";
        },
        set(this: object, value: unknown) {
          Object.defineProperty(this, "0", {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
        },
      });
      const actions = ["Heartbeat"];
      delete actions[0];
      result = validateLayerConfig({
        rules: {
          latency: {
            type: "latency",
            delayMs: 0,
            match: { actions },
          },
        },
      });
    } finally {
      if (indexDescriptor === undefined) {
        delete (Object.prototype as { 0?: unknown })[0];
      } else {
        Object.defineProperty(Object.prototype, "0", indexDescriptor);
      }
    }

    expect(result!.ok).toBe(false);
    expect(observed).toBe(false);
  });

  it("does not let an inherited toJSON bypass the serialized-size cap", () => {
    const toJSONDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const oversized = {
      rules: Object.fromEntries(
        Array.from(
          { length: NETWORK_SIM_LIMITS.maxRulesPerLayer },
          (_, ruleIndex) => [
            `rule-${ruleIndex}`,
            {
              type: "latency",
              delayMs: 0,
              match: {
                actions: Array.from(
                  { length: NETWORK_SIM_LIMITS.maxActions },
                  () => "x".repeat(NETWORK_SIM_LIMITS.maxActionLength),
                ),
              },
            },
          ],
        ),
      ),
    };

    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(NETWORK_SIM_LIMITS.maxSerializedBytes);

    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({}),
      });
      expectInvalid(oversized, ["serialized"]);
    } finally {
      if (toJSONDescriptor === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, "toJSON", toJSONDescriptor);
      }
    }
  });

  it("rejects bigint before a polluted BigInt.toJSON can materialize data", () => {
    const toJSONDescriptor = Object.getOwnPropertyDescriptor(
      BigInt.prototype,
      "toJSON",
    );
    let materializations = 0;

    try {
      Object.defineProperty(BigInt.prototype, "toJSON", {
        configurable: true,
        value: () => {
          materializations += 1;
          return "x".repeat(90_000);
        },
      });

      expectInvalid({ rules: {}, seed: 1n }, ["seed", "bigint"]);
      expect(materializations).toBe(0);
    } finally {
      if (toJSONDescriptor === undefined) {
        Reflect.deleteProperty(BigInt.prototype, "toJSON");
      } else {
        Object.defineProperty(BigInt.prototype, "toJSON", toJSONDescriptor);
      }
    }
  });

  it("rejects bigint in a rule field during the snapshot walk", () => {
    expectInvalid(
      {
        rules: {
          latency: {
            type: "latency",
            delayMs: 1n,
          },
        },
      },
      ["config.rules.latency.delayMs", "bigint"],
    );
  });

  it("rejects an undefined value instead of silently omitting it", () => {
    expectInvalid(
      {
        rules: {
          latency: {
            type: "latency",
            delayMs: undefined,
          },
        },
      },
      ["config.rules.latency.delayMs", "undefined"],
    );
  });

  it("rejects values that cannot be serialized", () => {
    const cyclic: { rules: object; self?: unknown } = { rules: {} };
    cyclic.self = cyclic;

    expectInvalid(cyclic, ["serialized"]);
    expectInvalid({ seed: 1n, rules: {} }, ["serialized", "seed"]);
  });

  it("collects all errors and never returns a partial config", () => {
    const result = validateLayerConfig({
      enabled: "yes",
      seed: -1,
      rules: {
        "": {
          type: "latency",
          delayMs: 120_001,
          match: { actions: [] },
          extra: true,
        },
        manual: {
          type: "manual-disconnect",
          reconnectDelayMs: -1,
          intervalMs: 1,
        },
      },
      unknown: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const path of [
        "enabled",
        "seed",
        "unknown",
        "rules",
        "delayMs",
        "match.actions",
        "extra",
        "reconnectDelayMs",
        "intervalMs",
      ]) {
        expect(result.errors.some((error) => error.includes(path))).toBe(true);
      }
      expect("config" in result).toBe(false);
    }
  });
});

describe("resolveNetworkSimConfig", () => {
  const layer = (
    value: Partial<NetworkSimLayerConfig> = {},
  ): NetworkSimLayerConfig => ({
    ...value,
    rules: value.rules ?? Object.create(null),
  });

  it("uses the enabled fallback chain and defaults to false", () => {
    expect(resolveNetworkSimConfig(null, null, "CP-1").enabled).toBe(false);
    expect(
      resolveNetworkSimConfig(layer({ enabled: true }), null, "CP-1").enabled,
    ).toBe(true);
    expect(
      resolveNetworkSimConfig(
        layer({ enabled: true }),
        layer({ enabled: false }),
        "CP-1",
      ).enabled,
    ).toBe(false);
  });

  it("derives charger-specific seeds from the global seed default", () => {
    expect(resolveNetworkSimConfig(null, null, "CP-A").seed).toBe(
      deriveSeed32(1, "CP-A"),
    );
    expect(
      resolveNetworkSimConfig(layer({ seed: 42 }), null, "CP-A").seed,
    ).toBe(deriveSeed32(42, "CP-A"));

    const first = resolveNetworkSimConfig(layer({ seed: 42 }), null, "CP-A");
    const second = resolveNetworkSimConfig(layer({ seed: 42 }), null, "CP-B");
    expect(first.seed).not.toBe(second.seed);
  });

  it("uses an explicit per-charger seed without derivation", () => {
    expect(
      resolveNetworkSimConfig(layer({ seed: 42 }), layer({ seed: 0 }), "CP-A")
        .seed,
    ).toBe(0);
    expect(
      resolveNetworkSimConfig(layer({ seed: 42 }), layer({ seed: 123 }), "CP-A")
        .seed,
    ).toBe(123);
    expect(
      resolveNetworkSimConfig(null, layer({ seed: 123 }), "CP-A").seed,
    ).toBe(resolveNetworkSimConfig(null, layer({ seed: 123 }), "CP-B").seed);
  });

  it("merges rules by key with per-charger overrides", () => {
    const globalRule = { type: "latency" as const, delayMs: 100 };
    const overriddenRule = {
      type: "manual-disconnect" as const,
      reconnectDelayMs: 200,
    };
    const chargerRule = {
      type: "periodic-disconnect" as const,
      intervalMs: 1_000,
      reconnectDelayMs: 300,
    };

    const resolved = resolveNetworkSimConfig(
      layer({ rules: { shared: globalRule, globalOnly: globalRule } }),
      layer({
        rules: { shared: overriddenRule, chargerOnly: chargerRule },
      }),
      "CP-A",
    );

    expect(resolved.rules).toEqual({
      shared: overriddenRule,
      globalOnly: globalRule,
      chargerOnly: chargerRule,
    });
    expect(Object.getPrototypeOf(resolved.rules)).toBeNull();
  });

  it("deletes inherited rules with null and treats missing targets as no-ops", () => {
    const inherited = { type: "latency" as const, delayMs: 100 };
    const resolved = resolveNetworkSimConfig(
      layer({ rules: { inherited } }),
      layer({ rules: { inherited: null, alreadyGone: null } }),
      "CP-A",
    );

    expect(resolved.rules).toEqual({});
    expect(Object.getPrototypeOf(resolved.rules)).toBeNull();
  });

  it("throws when the defensive resolved-rule invariant is exceeded", () => {
    const makeRules = (prefix: string, count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${prefix}-${index}`,
          { type: "latency" as const, delayMs: 0 },
        ]),
      );

    expect(() =>
      resolveNetworkSimConfig(
        layer({ rules: makeRules("global", 33) }),
        layer({ rules: makeRules("charger", 32) }),
        "CP-A",
      ),
    ).toThrow(/64/);
  });
});
