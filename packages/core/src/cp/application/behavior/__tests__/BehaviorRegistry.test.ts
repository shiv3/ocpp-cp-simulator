import { describe, expect, it, vi } from "vitest";
import {
  BehaviorRegistry,
  type BehaviorCall,
  type BehaviorRule,
  type HeldExchange,
  type RuleOwner,
} from "../BehaviorRegistry";

class FakeExchange implements HeldExchange {
  state: HeldExchange["state"] = "open";
  readonly answers: unknown[] = [];
  private listeners: Array<() => void> = [];
  constructor(
    readonly action = "UpdateFirmware",
    readonly messageId = "m1",
  ) {}
  onClosed(listener: () => void): void {
    if (this.state !== "open") listener();
    else this.listeners.push(listener);
  }
  private close(state: HeldExchange["state"]): void {
    this.state = state;
    for (const l of this.listeners.splice(0)) l();
  }
  reply(payload: unknown): void {
    this.answers.push({ result: payload });
    this.close("answered");
  }
  replyError(code: string, description: string): void {
    this.answers.push({ error: code, description });
    this.close("answered");
  }
  suppress(): void {
    this.answers.push({ none: true });
    this.close("suppressed");
  }
  answerNow(): void {
    this.reply({});
  }
}

const code = (behaviorId: string): RuleOwner => ({ kind: "code", behaviorId });
const scenario = (
  scenarioId: string,
  connectorId = 1,
  nodeId = "n1",
): RuleOwner => ({ kind: "scenario", scenarioId, connectorId, nodeId });

function rule(
  owner: RuleOwner,
  extra: Partial<BehaviorRule> = {},
  taken: Array<[BehaviorCall, HeldExchange]> = [],
): BehaviorRule {
  return {
    owner,
    action: "UpdateFirmware",
    mode: "replace",
    take: (call, exchange) => taken.push([call, exchange]),
    ...extra,
  };
}

const call = (extra: Partial<BehaviorCall> = {}): BehaviorCall => ({
  action: "UpdateFirmware",
  payload: { requestId: 7 },
  ...extra,
});

describe("BehaviorRegistry", () => {
  it("resolves to the default path when nothing is registered", () => {
    const registry = new BehaviorRegistry();
    expect(registry.resolve(call(), new FakeExchange())).toEqual({
      kind: "default",
    });
  });

  it("hands a matching CALL to the rule and holds its exchange", () => {
    const registry = new BehaviorRegistry();
    const taken: Array<[BehaviorCall, HeldExchange]> = [];
    registry.register(rule(code("a"), {}, taken));
    const exchange = new FakeExchange();
    expect(registry.resolve(call(), exchange).kind).toBe("taken");
    expect(taken).toHaveLength(1);
    expect(taken[0][1]).toBe(exchange);
  });

  it("matches the payload with a deep partial match", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("a"), { match: { requestId: 8 } }));
    expect(registry.resolve(call(), new FakeExchange()).kind).toBe("default");
    registry.register(rule(code("b"), { match: { requestId: 7 } }));
    expect(registry.resolve(call(), new FakeExchange()).kind).toBe("taken");
  });

  it("translates action names on 2.x only", () => {
    const v16 = new BehaviorRegistry({ ocppVersion: () => "OCPP-1.6J" });
    v16.register(rule(code("a"), { action: "SignedUpdateFirmware" }));
    expect(v16.resolve(call(), new FakeExchange()).kind).toBe("default");

    const v201 = new BehaviorRegistry({ ocppVersion: () => "OCPP-2.0.1" });
    v201.register(rule(code("a"), { action: "SignedUpdateFirmware" }));
    expect(v201.resolve(call(), new FakeExchange()).kind).toBe("taken");
  });

  it("prefers the exact connector, then the oldest registration, and warns", () => {
    const warn = vi.fn();
    const registry = new BehaviorRegistry({ warn });
    const first: Array<[BehaviorCall, HeldExchange]> = [];
    const second: Array<[BehaviorCall, HeldExchange]> = [];
    const exact: Array<[BehaviorCall, HeldExchange]> = [];
    registry.register(rule(code("any-old"), {}, first));
    registry.register(rule(code("any-new"), {}, second));
    registry.register(rule(code("c2"), { connectorId: 2 }, exact));

    registry.resolve(call({ connectorId: 2 }), new FakeExchange());
    expect(exact).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("code:c2");
    expect(warn.mock.calls[0][0]).toContain("code:any-old");

    registry.resolve(
      call({ connectorId: 1 }),
      new FakeExchange("UpdateFirmware", "m2"),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("a CALL without a connector matches any-connector rules only", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("c1"), { connectorId: 1 }));
    expect(registry.resolve(call(), new FakeExchange()).kind).toBe("default");
    registry.register(rule(code("any")));
    expect(registry.resolve(call(), new FakeExchange()).kind).toBe("taken");
  });

  it("answers onBusy at once while a rule holds an open exchange", () => {
    const registry = new BehaviorRegistry();
    const taken: Array<[BehaviorCall, HeldExchange]> = [];
    registry.register(
      rule(
        code("a"),
        { onBusy: { error: { code: "Busy", description: "x" } } },
        taken,
      ),
    );
    const first = new FakeExchange();
    const second = new FakeExchange("UpdateFirmware", "m2");
    expect(registry.resolve(call(), first).kind).toBe("taken");
    expect(registry.resolve(call(), second).kind).toBe("busy");
    expect(second.answers).toEqual([{ error: "Busy", description: "x" }]);
    expect(taken).toHaveLength(1);
  });

  it("onBusy defaults to CALLERROR GenericError and may be silence or a result", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("a")));
    registry.resolve(call(), new FakeExchange());
    const busy = new FakeExchange("UpdateFirmware", "m2");
    registry.resolve(call(), busy);
    expect(busy.answers[0]).toMatchObject({ error: "GenericError" });

    const silent = new BehaviorRegistry();
    silent.register(rule(code("a"), { onBusy: { noResponse: true } }));
    silent.resolve(call(), new FakeExchange());
    const quiet = new FakeExchange("UpdateFirmware", "m2");
    silent.resolve(call(), quiet);
    expect(quiet.answers).toEqual([{ none: true }]);

    const result = new BehaviorRegistry();
    result.register(
      rule(code("a"), { onBusy: { response: { status: "Rejected" } } }),
    );
    result.resolve(call(), new FakeExchange());
    const rejected = new FakeExchange("UpdateFirmware", "m2");
    result.resolve(call(), rejected);
    expect(rejected.answers).toEqual([{ result: { status: "Rejected" } }]);
  });

  it("serves the next CALL once the exchange was answered", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("a")));
    const first = new FakeExchange();
    registry.resolve(call(), first);
    first.answerNow();
    expect(
      registry.resolve(call(), new FakeExchange("UpdateFirmware", "m2")).kind,
    ).toBe("taken");
  });

  it("releases by owner and returns the exchanges still open", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(scenario("s1", 1, "n1")));
    registry.register(rule(code("a")));
    const open = new FakeExchange();
    registry.resolve(call({ connectorId: 1 }), open);
    // The scenario rule is oldest and wins on connector 1.
    const released = registry.release(
      (owner) => owner.kind === "scenario" && owner.scenarioId === "s1",
    );
    expect(released).toEqual([open]);
    expect(registry.size).toBe(1);
    expect(
      registry.resolve(call(), new FakeExchange("UpdateFirmware", "m2")).kind,
    ).toBe("taken");
  });

  it("does not return an exchange that already ended", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("a")));
    const done = new FakeExchange();
    registry.resolve(call(), done);
    done.answerNow();
    expect(registry.release((owner) => owner.kind === "code")).toEqual([]);
  });

  it("refuses the same owner and action twice", () => {
    const registry = new BehaviorRegistry();
    registry.register(rule(code("a")));
    expect(() => registry.register(rule(code("a")))).toThrow(/already/);
  });

  it("an unregister function removes only its rule", () => {
    const registry = new BehaviorRegistry();
    const off = registry.register(rule(code("a")));
    registry.register(rule(code("b"), { action: "Reset" }));
    off();
    expect(registry.size).toBe(1);
    expect(registry.resolve(call(), new FakeExchange()).kind).toBe("default");
  });
});
