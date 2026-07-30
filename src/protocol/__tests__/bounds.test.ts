import { describe, expect, it } from "vitest";

import { eventToWire } from "../events";
import { METHODS } from "../methods";

// Locks in the protocol-review fixes (B-1 url-cred strip, B-2 scenario bound).

describe("eventToWire url-credential stripping (B-1)", () => {
  it("strips embedded user:pass@ from URL-shaped string values", () => {
    const wire = eventToWire({
      event: "log",
      data: { endpoint: "ws://user:pass@host:9000/ocpp", note: "ok" },
    });
    const json = JSON.stringify(wire);
    expect(json).not.toContain("pass@");
    expect(json).toContain("ws://host:9000/ocpp");
    expect(json).toContain("ok");
  });
});

describe("scenario object size bound (B-2)", () => {
  // Well-shaped so these exercise the SIZE bound only: `load_scenario` also
  // requires the fields the runtime keys on, and a shapeless fixture would
  // fail for that reason instead.
  const scenario = (extra: Record<string, unknown> = {}) => ({
    id: "s1",
    name: "S1",
    targetType: "connector",
    nodes: [{ id: "n1" }],
    edges: [],
    ...extra,
  });

  it("rejects a scenario object over 256 KB", () => {
    expect(
      METHODS.load_scenario.params.safeParse({
        connector: 1,
        scenario: scenario({ blob: "x".repeat(300_000) }),
      }).success,
    ).toBe(false);
  });

  it("accepts a normal scenario object", () => {
    expect(
      METHODS.load_scenario.params.safeParse({
        connector: 1,
        scenario: scenario(),
      }).success,
    ).toBe(true);
  });

  it("rejects a scenario missing the fields the runtime keys on", () => {
    for (const field of ["id", "name", "targetType", "nodes", "edges"]) {
      const def = scenario() as Record<string, unknown>;
      delete def[field];
      expect(
        METHODS.load_scenario.params.safeParse({ connector: 1, scenario: def })
          .success,
      ).toBe(false);
    }
  });

  it("bounds generic object params (set_ev_settings) at 64 KB", () => {
    const big = { blob: "x".repeat(70_000) };
    expect(
      METHODS.set_ev_settings.params.safeParse({ connector: 1, settings: big })
        .success,
    ).toBe(false);
  });
});
