import { describe, expect, it, vi } from "vitest";
import {
  BehaviorRegistry,
  type BehaviorCall,
} from "../../../../application/behavior/BehaviorRegistry";
import type { InboundCallPolicy } from "../../../../domain/charge-point/ChargePoint";
import { ResponseEffectQueue } from "../../network-sim/ResponseEffectQueue";
import { CallExchange } from "../CallExchange";
import { InboundCallGate, ports16, portsAliased } from "../InboundCallGate";

interface Recorder {
  events: string[];
  frames: string[];
}

function exchangeFor(action: string, rec: Recorder): CallExchange {
  return new CallExchange({
    action,
    messageId: "m-1",
    generation: { gen: 1, closeCause: null },
    isGenerationCurrent: () => true,
    announce: (c) => rec.events.push(`announce:${c.outcome}`),
    writeResult: (p) => rec.frames.push(`result:${JSON.stringify(p)}`),
    writeError: (code) => rec.frames.push(`error:${code}`),
    effects: new ResponseEffectQueue({
      isGenerationCurrent: () => true,
      defer: (run) => run(),
      log: () => {},
    }),
    warn: () => {},
  });
}

/** A charge point double with the policy / override table of the real one. */
function chargePointDouble(rec: Recorder) {
  const policies = new Map<string, InboundCallPolicy>();
  const overrides = new Map<string, string>();
  return {
    policies,
    overrides,
    notifyIncomingCall: vi.fn((action: string) => {
      rec.events.push(`received:${action}`);
    }),
    getInboundCallPolicy: (action: string) => policies.get(action),
    hasResponseOverride: (action: string) => overrides.has(action),
    consumeResponseOverride: (action: string) => {
      const status = overrides.get(action) ?? null;
      overrides.delete(action);
      return status;
    },
    clearResponseOverride: (action: string) => {
      overrides.delete(action);
    },
  };
}

const gate = (
  cp: ReturnType<typeof chargePointDouble>,
  options: {
    aliased?: boolean;
    registry?: BehaviorRegistry;
    log?: string[];
  } = {},
) =>
  new InboundCallGate({
    ports: options.aliased
      ? portsAliased(cp, new Set(["GetVariables", "SetVariables"]))
      : ports16(cp),
    registry: options.registry,
    info: (m) => options.log?.push(`info:${m}`),
    warn: (m) => options.log?.push(`warn:${m}`),
  });

describe("InboundCallGate", () => {
  it("announces the CALL first, and passes an unremarkable one to the default path", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    const ex = exchangeFor("Reset", rec);
    expect(gate(cp).admit(ex, { type: "Soft" })).toEqual({ kind: "default" });
    expect(rec.events).toEqual(["received:Reset"]);
    expect(ex.state).toBe("open");
    expect(rec.frames).toEqual([]);
  });

  it("an inbound callerror policy answers with that CALLERROR, before an override and the registry", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    cp.policies.set("Reset", {
      kind: "callerror",
      errorCode: "NotSupported",
      errorDescription: "no",
    });
    cp.overrides.set("Reset", "Rejected");
    const resolve = vi.fn();
    const registry = { resolve } as unknown as BehaviorRegistry;
    const ex = exchangeFor("Reset", rec);
    expect(gate(cp, { registry }).admit(ex, {})).toEqual({ kind: "settled" });
    expect(rec.frames).toEqual(["error:NotSupported"]);
    expect(rec.events).toEqual(["received:Reset", "announce:CallError"]);
    // the one-shot override was not consumed, the registry not asked
    expect(cp.overrides.get("Reset")).toBe("Rejected");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("an ignore policy leaves the CALL unanswered", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    cp.policies.set("Reset", { kind: "ignore" });
    const ex = exchangeFor("Reset", rec);
    expect(gate(cp).admit(ex, {})).toEqual({ kind: "settled" });
    expect(ex.state).toBe("suppressed");
    expect(rec.frames).toEqual([]);
    expect(rec.events).toEqual(["received:Reset", "announce:NoResponse"]);
  });

  it("a response override answers { status } once, then the next CALL goes the default way", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    cp.overrides.set("UnlockConnector", "Failed");
    const g = gate(cp);
    const first = exchangeFor("UnlockConnector", rec);
    expect(g.admit(first, {})).toEqual({ kind: "settled" });
    expect(rec.frames).toEqual(['result:{"status":"Failed"}']);
    const second = exchangeFor("UnlockConnector", rec);
    expect(g.admit(second, {})).toEqual({ kind: "default" });
  });

  it("asks the registry after policy and override, before the default path, with the connector", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    const calls: BehaviorCall[] = [];
    const registry = {
      resolve: (call: BehaviorCall) => {
        calls.push(call);
        return { kind: "default" as const };
      },
    } as unknown as BehaviorRegistry;
    const g = gate(cp, { registry });
    g.admit(exchangeFor("UnlockConnector", rec), { connectorId: 2 });
    g.admit(exchangeFor("TriggerMessage", rec), {
      evse: { id: 1, connectorId: 3 },
    });
    g.admit(exchangeFor("Reset", rec), { type: "Soft" });
    expect(calls.map((c) => [c.action, c.connectorId])).toEqual([
      ["UnlockConnector", 2],
      ["TriggerMessage", 3],
      ["Reset", undefined],
    ]);
  });

  it("the default registry diverts nothing", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    expect(
      gate(cp, { registry: new BehaviorRegistry() }).admit(
        exchangeFor("Reset", rec),
        {},
      ),
    ).toEqual({ kind: "default" });
  });

  it("answers in the turn it was asked: nothing is deferred by a microtask (#456)", () => {
    const rec: Recorder = { events: [], frames: [] };
    const cp = chargePointDouble(rec);
    cp.overrides.set("Reset", "Rejected");
    gate(cp).admit(exchangeFor("Reset", rec), {});
    expect(rec.frames).toHaveLength(1);
  });

  describe("2.x spellings", () => {
    it("finds a policy set under the 1.6 name for the 2.x action", () => {
      const rec: Recorder = { events: [], frames: [] };
      const cp = chargePointDouble(rec);
      cp.policies.set("RemoteStartTransaction", {
        kind: "callerror",
        errorCode: "NotSupported",
        errorDescription: "no",
      });
      const ex = exchangeFor("RequestStartTransaction", rec);
      expect(gate(cp, { aliased: true }).admit(ex, {})).toEqual({
        kind: "settled",
      });
      expect(rec.frames).toEqual(["error:NotSupported"]);
    });

    it("an override armed under the 1.6 name is consumed under every spelling", () => {
      const rec: Recorder = { events: [], frames: [] };
      const cp = chargePointDouble(rec);
      cp.overrides.set("RemoteStartTransaction", "Rejected");
      cp.overrides.set("RequestStartTransaction", "Rejected");
      const g = gate(cp, { aliased: true });
      expect(g.admit(exchangeFor("RequestStartTransaction", rec), {})).toEqual({
        kind: "settled",
      });
      expect(rec.frames).toEqual(['result:{"status":"Rejected"}']);
      expect(cp.overrides.size).toBe(0);
    });

    it("an override on an action whose answer is not { status } is consumed, warned about, and the real handler answers", () => {
      const rec: Recorder = { events: [], frames: [] };
      const cp = chargePointDouble(rec);
      cp.overrides.set("GetVariables", "Rejected");
      const log: string[] = [];
      const ex = exchangeFor("GetVariables", rec);
      expect(gate(cp, { aliased: true, log }).admit(ex, {})).toEqual({
        kind: "default",
      });
      expect(rec.frames).toEqual([]);
      expect(cp.overrides.size).toBe(0);
      expect(
        log.some((l) => l.startsWith("warn:") && l.includes("GetVariables")),
      ).toBe(true);
    });
  });

  describe("disconnect", () => {
    it("abandonAll abandons the exchanges still open, and only those", () => {
      const rec: Recorder = { events: [], frames: [] };
      const cp = chargePointDouble(rec);
      const g = gate(cp);
      const waiting = exchangeFor("Reset", rec);
      const answered = exchangeFor("ClearCache", rec);
      g.track(waiting);
      g.track(answered);
      answered.reply({ status: "Accepted" });
      g.abandonAll();
      expect(waiting.state).toBe("abandoned");
      expect(answered.state).toBe("answered");
      expect(
        rec.events.filter((e) => e === "announce:NoResponse"),
      ).toHaveLength(1);
      // a second abandon has nothing left to do
      g.abandonAll();
      expect(
        rec.events.filter((e) => e === "announce:NoResponse"),
      ).toHaveLength(1);
    });
  });
});
