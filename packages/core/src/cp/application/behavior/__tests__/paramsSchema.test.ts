import { describe, expect, it } from "vitest";
import type { BehaviorParams } from "@ocpp-cp-simulator/contracts/behavior";
import {
  freezeParams,
  mergeParams,
  paramsDeclarationProblem,
  schemaProblem,
  validateParams,
} from "../paramsSchema";

const declared: BehaviorParams = {
  schema: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: ["a", "b"] },
      n: { type: "integer", minimum: 1, maximum: 5 },
      ratio: { type: "number" },
      on: { type: "boolean" },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      nested: {
        type: "object",
        properties: { k: { type: "string", maxLength: 3 } },
      },
    },
  },
  defaults: { mode: "a", n: 1 },
};

describe("validateParams", () => {
  it("accepts a fitting value", () => {
    expect(
      validateParams(declared.schema, {
        mode: "b",
        n: 5,
        ratio: 0.5,
        on: false,
        tags: ["x"],
        nested: { k: "abc" },
      }),
    ).toBeNull();
  });

  it("refuses and never coerces", () => {
    for (const [value, message] of [
      [
        { mode: "a", n: "3" },
        'expected integer, got "3" (strings are not converted)',
      ],
      [{ mode: "a", n: 2.5 }, "expected integer"],
      [{ mode: "a", n: 0 }, "below the minimum"],
      [{ mode: "a", on: "true" }, "expected boolean"],
      [{ mode: "a", ratio: "1" }, "expected number"],
      [{ mode: "c" }, "must be one of"],
      [{ n: 1 }, "params.mode: required"],
      [{ mode: "a", extra: 1 }, "unknown parameter"],
      [{ mode: "a", tags: ["a", "b", "c"] }, "more than 2 items"],
      [{ mode: "a", tags: [1] }, "expected string"],
      [{ mode: "a", nested: { k: "toolong" } }, "longer than 3"],
      [{ mode: "a", nested: { z: 1 } }, "unknown parameter"],
    ] as const) {
      expect(validateParams(declared.schema, value)).toContain(message);
    }
  });

  it("refuses what is not JSON", () => {
    expect(validateParams(declared.schema, { mode: "a", n: NaN })).toContain(
      "finite",
    );
    expect(
      validateParams(declared.schema, { mode: "a", n: (() => 1) as never }),
    ).toContain("not JSON");
    expect(
      validateParams(declared.schema, { mode: "a", n: undefined }),
    ).toContain("undefined");
    class Thing {}
    expect(
      validateParams(declared.schema, { mode: "a", nested: new Thing() }),
    ).toContain("plain JSON object");
  });

  it("allows extra keys only when the schema says so", () => {
    expect(
      validateParams(
        { type: "object", additionalProperties: true },
        { anything: 1 },
      ),
    ).toBeNull();
  });
});

describe("schemaProblem / paramsDeclarationProblem", () => {
  it("refuses a keyword outside the subset", () => {
    expect(schemaProblem({ type: "object", pattern: "^a" })).toContain(
      'keyword "pattern"',
    );
    expect(schemaProblem({ type: "object", oneOf: [] })).toContain("oneOf");
    expect(schemaProblem({ type: "date" })).toContain("type");
    expect(schemaProblem({ type: "object", $ref: "#/x" })).toContain("$ref");
  });

  it("needs an object root and defaults that fit", () => {
    expect(paramsDeclarationProblem(undefined)).toBeNull();
    expect(paramsDeclarationProblem(declared)).toBeNull();
    expect(
      paramsDeclarationProblem({ schema: { type: "string" }, defaults: {} }),
    ).toContain('root must have type "object"');
    expect(
      paramsDeclarationProblem({ ...declared, defaults: { mode: "z" } }),
    ).toContain("params.defaults");
  });
});

describe("mergeParams", () => {
  it("lays layers over the defaults, one level deep", () => {
    expect(
      mergeParams("b", declared, [{ n: 3 }, { mode: "b", nested: { k: "x" } }]),
    ).toEqual({ mode: "b", n: 3, nested: { k: "x" } });
    // A layer's key replaces the whole value (shallow).
    expect(
      mergeParams("b", declared, [{ nested: { k: "x" } }, { nested: {} }]),
    ).toEqual({ mode: "a", n: 1, nested: {} });
  });

  it("names the behavior when the result does not fit", () => {
    expect(() => mergeParams("b", declared, [{ n: 9 }])).toThrow(
      "Behavior b: invalid params: params.n: 9 is above the maximum 5",
    );
  });

  it("refuses params for a behavior that declares none", () => {
    expect(() => mergeParams("p", undefined, [{ a: 1 }])).toThrow(
      "declares no params",
    );
    expect(mergeParams("p", undefined, [{}])).toEqual({});
  });

  it("refuses __proto__ as a name, so it never reaches a prototype", () => {
    const layer = JSON.parse('{"__proto__": {"n": 2}}') as never;
    const loose: BehaviorParams = {
      schema: { type: "object", additionalProperties: true },
      defaults: {},
    };
    expect(() => mergeParams("l", loose, [layer])).toThrow("__proto__");
    expect(({} as Record<string, unknown>).n).toBeUndefined();
  });
});

describe("freezeParams", () => {
  it("is a deep frozen copy", () => {
    const source = { a: { b: [1, { c: 2 }] } };
    const frozen = freezeParams(source) as typeof source;
    expect(frozen).toEqual(source);
    expect(frozen).not.toBe(source);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
    expect(Object.isFrozen(frozen.a.b[1])).toBe(true);
    expect(() => {
      (frozen.a as { b: unknown }).b = 1;
    }).toThrow();
  });
});
