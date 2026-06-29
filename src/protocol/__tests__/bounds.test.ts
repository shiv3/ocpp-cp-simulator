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
  it("rejects a scenario object over 256 KB", () => {
    const big = { blob: "x".repeat(300_000) };
    expect(
      METHODS.load_scenario.params.safeParse({ connector: 1, scenario: big })
        .success,
    ).toBe(false);
  });

  it("accepts a normal scenario object", () => {
    const ok = { nodes: [{ id: "n1" }] };
    expect(
      METHODS.load_scenario.params.safeParse({ connector: 1, scenario: ok })
        .success,
    ).toBe(true);
  });

  it("bounds generic object params (set_ev_settings) at 64 KB", () => {
    const big = { blob: "x".repeat(70_000) };
    expect(
      METHODS.set_ev_settings.params.safeParse({ connector: 1, settings: big })
        .success,
    ).toBe(false);
  });
});
