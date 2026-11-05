import { describe, expect, it, vi } from "vitest";

import { parseFrameContext } from "../FrameContext";
import { evaluateDelayMs } from "../LatencyPolicy";
import type { ResolvedNetworkSimConfig } from "../config";

type Rules = ResolvedNetworkSimConfig["rules"];

const fixedRngFor =
  (value: number): ((ruleId: string) => () => number) =>
  () =>
  () =>
    value;

describe("parseFrameContext", () => {
  it("parses a CALL with its action, message id, and message type", () => {
    const raw = JSON.stringify([
      2,
      "call-1",
      "BootNotification",
      { reason: "PowerUp" },
    ]);

    expect(parseFrameContext(raw, "upstream")).toEqual({
      direction: "upstream",
      messageType: 2,
      action: "BootNotification",
      messageId: "call-1",
      byteSize: new TextEncoder().encode(raw).byteLength,
    });
  });

  it("parses a CALLRESULT without an action", () => {
    const context = parseFrameContext(
      JSON.stringify([3, "call-1", { status: "Accepted" }]),
      "downstream",
    );

    expect(context).toMatchObject({
      direction: "downstream",
      messageType: 3,
      messageId: "call-1",
    });
    expect(context.action).toBeUndefined();
  });

  it("parses a CALLERROR without an action", () => {
    const context = parseFrameContext(
      JSON.stringify([4, "call-1", "InternalError", "failed", {}]),
      "downstream",
    );

    expect(context).toMatchObject({
      direction: "downstream",
      messageType: 4,
      messageId: "call-1",
    });
    expect(context.action).toBeUndefined();
  });

  it.each([
    [
      "message id",
      JSON.stringify([2, 123, "BootNotification", {}]),
      { messageId: undefined, action: "BootNotification" },
    ],
    [
      "action",
      JSON.stringify([2, "call-1", 123, {}]),
      { messageId: "call-1", action: undefined },
    ],
  ])("leaves a non-string CALL %s undefined", (_name, raw, expected) => {
    expect(parseFrameContext(raw, "upstream")).toMatchObject(expected);
  });

  it.each([
    ["non-JSON", "not JSON"],
    ["non-array JSON", JSON.stringify({ messageType: 2 })],
    ["an invalid OCPP-J shape", JSON.stringify([2, "call-1"])],
  ])("returns undefined frame metadata for %s", (_name, raw) => {
    expect(() => parseFrameContext(raw, "upstream")).not.toThrow();
    expect(parseFrameContext(raw, "upstream")).toEqual({
      direction: "upstream",
      messageType: undefined,
      action: undefined,
      messageId: undefined,
      byteSize: new TextEncoder().encode(raw).byteLength,
    });
  });

  it("measures byte size as UTF-8", () => {
    const raw = JSON.stringify([2, "識別子", "起動通知", {}]);

    expect(parseFrameContext(raw, "upstream").byteSize).toBe(
      new TextEncoder().encode(raw).byteLength,
    );
    expect(parseFrameContext(raw, "upstream").byteSize).toBeGreaterThan(
      raw.length,
    );
  });

  it("parses JSON exactly once per invocation", () => {
    const raw = JSON.stringify([2, "call-1", "Heartbeat", {}]);
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      parseFrameContext(raw, "upstream");
      expect(parseSpy).toHaveBeenCalledOnce();
      expect(parseSpy).toHaveBeenCalledWith(raw);
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe("evaluateDelayMs", () => {
  it("matches a CALL action against an actions rule", () => {
    const context = parseFrameContext(
      JSON.stringify([2, "call-1", "BootNotification", {}]),
      "upstream",
    );
    const rules: Rules = {
      boot: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 250,
      },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(250);
  });

  it("applies only match-less rules to a CALLRESULT", () => {
    const context = parseFrameContext(
      JSON.stringify([3, "call-1", {}]),
      "downstream",
    );
    const rules: Rules = {
      callsOnly: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 100,
      },
      everyFrame: { type: "latency", delayMs: 200 },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(200);
  });

  it("applies only match-less rules to a CALLERROR", () => {
    const context = parseFrameContext(
      JSON.stringify([4, "call-1", "InternalError", "failed", {}]),
      "downstream",
    );
    const rules: Rules = {
      callsOnly: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 100,
      },
      everyFrame: { type: "latency", delayMs: 200 },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(200);
  });

  it("applies only match-less rules to an unparseable frame", () => {
    const context = parseFrameContext("not JSON", "upstream");
    const rules: Rules = {
      callsOnly: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 100,
      },
      everyFrame: { type: "latency", delayMs: 200 },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(200);
  });

  it("matches a downstream CALL action", () => {
    const context = parseFrameContext(
      JSON.stringify([2, "call-1", "Reset", {}]),
      "downstream",
    );
    const rules: Rules = {
      downstreamReset: {
        type: "latency",
        direction: "downstream",
        match: { actions: ["Reset"] },
        delayMs: 175,
      },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(175);
  });

  it("does not match a CALL action absent from match.actions", () => {
    const context = parseFrameContext(
      JSON.stringify([2, "call-1", "Heartbeat", {}]),
      "upstream",
    );
    const rules: Rules = {
      bootOnly: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 100,
      },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(0);
  });

  it("does not match an actions rule when the CALL action is non-string", () => {
    const context = parseFrameContext(
      JSON.stringify([2, "call-1", 123, {}]),
      "upstream",
    );
    const rules: Rules = {
      callsOnly: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 100,
      },
    };

    expect(context.action).toBeUndefined();
    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(0);
  });

  it("filters by direction while defaulting to both", () => {
    const context = parseFrameContext(
      JSON.stringify([2, "call-1", "Heartbeat", {}]),
      "downstream",
    );
    const rules: Rules = {
      upstreamOnly: {
        type: "latency",
        direction: "upstream",
        delayMs: 100,
      },
      explicitBoth: {
        type: "latency",
        direction: "both",
        delayMs: 200,
      },
      defaultBoth: { type: "latency", delayMs: 300 },
    };

    expect(evaluateDelayMs(context, rules, fixedRngFor(0))).toBe(500);
  });

  it("uses draw for deterministic jitter", () => {
    const rng = vi.fn(() => 0x80000000);
    const rngFor = vi.fn(() => rng);
    const rules: Rules = {
      jittered: { type: "latency", delayMs: 100, jitterMs: 10 },
    };

    expect(
      evaluateDelayMs(
        {
          direction: "upstream",
          byteSize: 0,
        },
        rules,
        rngFor,
      ),
    ).toBe(105);
    expect(rngFor).toHaveBeenCalledWith("jittered");
    expect(rng).toHaveBeenCalledOnce();
  });

  it("draws jitter in stable rule order and skips non-matching rules", () => {
    const drawA = vi.fn(() => 0x40000000);
    const skippedDraw = vi.fn(() => 0xffffffff);
    const drawB = vi.fn(() => 0x80000000);
    const generators: Record<string, () => number> = {
      matchingA: drawA,
      nonMatching: skippedDraw,
      matchingB: drawB,
    };
    const rngFor = vi.fn((ruleId: string) => generators[ruleId]);
    const rules: Rules = {
      matchingA: {
        type: "latency",
        match: { actions: ["Heartbeat"] },
        delayMs: 100,
        jitterMs: 8,
      },
      nonMatching: {
        type: "latency",
        match: { actions: ["BootNotification"] },
        delayMs: 1_000,
        jitterMs: 1_000,
      },
      matchingB: {
        type: "latency",
        match: { actions: ["Heartbeat"] },
        delayMs: 200,
        jitterMs: 10,
      },
    };

    expect(
      evaluateDelayMs(
        {
          direction: "upstream",
          action: "Heartbeat",
          byteSize: 0,
        },
        rules,
        rngFor,
      ),
    ).toBe(100 + 2 + 200 + 5);
    expect(rngFor).toHaveBeenCalledTimes(2);
    expect(rngFor).toHaveBeenNthCalledWith(1, "matchingA");
    expect(rngFor).toHaveBeenNthCalledWith(2, "matchingB");
    expect(drawA).toHaveBeenCalledOnce();
    expect(skippedDraw).not.toHaveBeenCalled();
    expect(drawB).toHaveBeenCalledOnce();
  });

  it("sums matching latency rules and saturates at 120000", () => {
    const rules: Rules = {
      first: { type: "latency", delayMs: 70_000 },
      ignored: { type: "manual-disconnect", reconnectDelayMs: 1 },
      second: { type: "latency", delayMs: 50_000, jitterMs: 20 },
    };

    expect(
      evaluateDelayMs(
        {
          direction: "upstream",
          byteSize: 0,
        },
        rules,
        fixedRngFor(0xffffffff),
      ),
    ).toBe(120_000);
  });

  it("returns zero when no rules match", () => {
    const rules: Rules = {
      disconnect: { type: "manual-disconnect", reconnectDelayMs: 1_000 },
      downstream: {
        type: "latency",
        direction: "downstream",
        delayMs: 100,
      },
    };

    expect(
      evaluateDelayMs(
        {
          direction: "upstream",
          action: "Heartbeat",
          byteSize: 12,
        },
        rules,
        fixedRngFor(0),
      ),
    ).toBe(0);
  });

  it("returns zero for an empty rules record", () => {
    expect(
      evaluateDelayMs(
        {
          direction: "upstream",
          byteSize: 0,
        },
        {},
        fixedRngFor(0),
      ),
    ).toBe(0);
  });
});
