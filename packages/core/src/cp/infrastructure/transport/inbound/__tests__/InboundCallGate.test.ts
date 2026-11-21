import { describe, expect, it, vi } from "vitest";
import {
  BehaviorRegistry,
  type BehaviorCall,
} from "../../../../application/behavior/BehaviorRegistry";
import type { ChargePointBehaviorRegistry } from "../../../../domain/engine/behaviorRules";
import type { InboundCallPolicy } from "../../../../domain/charge-point/ChargePoint";
import { CallOverrides } from "../../../../domain/charge-point/CallOverrides";
import { ResponseEffectQueue } from "../../network-sim/ResponseEffectQueue";
import { CallExchange } from "../CallExchange";
import { InboundCallGate, ports16, portsAliased } from "../InboundCallGate";

interface Recorder {
  events: string[];
  frames: string[];
  timers: { delayMs: number; run: () => void }[];
}

function exchangeFor(action: string, rec: Recorder): CallExchange {
  return new CallExchange({
    action,
    messageId: "m-1",
    generation: { gen: 1, closeCause: null },
    isGenerationCurrent: () => true,
    announce: (c) => rec.events.push(`announce:${c.outcome}`),
    writeResult: (p) => rec.frames.push(`result:${JSON.stringify(p)}`),
    writeError: (code, _description, _generation, _onSettled, details) =>
      rec.frames.push(
        `error:${code}${details === undefined ? "" : `:${JSON.stringify(details)}`}`,
      ),
    writeRaw: (frame) => rec.frames.push(`raw:${frame}`),
    schedule: (delayMs, run) => rec.timers.push({ delayMs, run }),
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
    consumeResponse: (action: string) => {
      const status = overrides.get(action);
      overrides.delete(action);
      return status === undefined ? null : { mode: "status" as const, status };
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
    registry?: ChargePointBehaviorRegistry;
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
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const cp = chargePointDouble(rec);
    const ex = exchangeFor("Reset", rec);
    expect(gate(cp).admit(ex, { type: "Soft" })).toEqual({ kind: "default" });
    expect(rec.events).toEqual(["received:Reset"]);
    expect(ex.state).toBe("open");
    expect(rec.frames).toEqual([]);
  });

  it("an inbound callerror policy answers with that CALLERROR, before an override and the registry", () => {
    const rec: Recorder = { events: [], frames: [], timers: [] };
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
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const cp = chargePointDouble(rec);
    cp.policies.set("Reset", { kind: "ignore" });
    const ex = exchangeFor("Reset", rec);
    expect(gate(cp).admit(ex, {})).toEqual({ kind: "settled" });
    expect(ex.state).toBe("suppressed");
    expect(rec.frames).toEqual([]);
    expect(rec.events).toEqual(["received:Reset", "announce:NoResponse"]);
  });

  it("a response override answers { status } once, then the next CALL goes the default way", () => {
    const rec: Recorder = { events: [], frames: [], timers: [] };
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
    const rec: Recorder = { events: [], frames: [], timers: [] };
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
      // The EVSE names the connector (this simulator maps them one to one);
      // `evse.connectorId` is the index within the EVSE.
      ["TriggerMessage", 1],
      ["Reset", undefined],
    ]);
  });

  it("the default registry diverts nothing", () => {
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const cp = chargePointDouble(rec);
    expect(
      gate(cp, { registry: new BehaviorRegistry() }).admit(
        exchangeFor("Reset", rec),
        {},
      ),
    ).toEqual({ kind: "default" });
  });

  it("takes any registry that implements the domain interface (#575)", () => {
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const cp = chargePointDouble(rec);
    const resolve = vi.fn((_call: BehaviorCall) => ({
      kind: "default" as const,
    }));
    const registry: ChargePointBehaviorRegistry = {
      register: () => () => {},
      ranks: () => new Map(),
      release: () => [],
      resolve,
    };
    gate(cp, { registry }).admit(exchangeFor("Reset", rec), { type: "Soft" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({ action: "Reset" });
  });

  it("answers in the turn it was asked: nothing is deferred by a microtask (#456)", () => {
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const cp = chargePointDouble(rec);
    cp.overrides.set("Reset", "Rejected");
    gate(cp).admit(exchangeFor("Reset", rec), {});
    expect(rec.frames).toHaveLength(1);
  });

  describe("2.x spellings", () => {
    it("finds a policy set under the 1.6 name for the 2.x action", () => {
      const rec: Recorder = { events: [], frames: [], timers: [] };
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
      const rec: Recorder = { events: [], frames: [], timers: [] };
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
      const rec: Recorder = { events: [], frames: [], timers: [] };
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
      const rec: Recorder = { events: [], frames: [], timers: [] };
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

  describe("capability profile error code (#618)", () => {
    const disabling = (
      rec: Recorder,
      code?: "NotImplemented" | "NotSupported",
    ) => ({
      ...chargePointDouble(rec),
      isActionDisabled: (action: string) => action === "ReserveNow",
      ...(code ? { disabledActionErrorCode: () => code } : {}),
    });

    it("answers a disabled action NotImplemented by default", () => {
      const rec: Recorder = { events: [], frames: [], timers: [] };
      const ex = exchangeFor("ReserveNow", rec);
      expect(gate(disabling(rec)).admit(ex, {})).toEqual({ kind: "settled" });
      expect(rec.frames).toEqual(["error:NotImplemented"]);
    });

    it("answers with the profile's code, on 1.6 and aliased ports alike", () => {
      for (const aliased of [false, true]) {
        const rec: Recorder = { events: [], frames: [], timers: [] };
        const log: string[] = [];
        const ex = exchangeFor("ReserveNow", rec);
        expect(
          gate(disabling(rec, "NotSupported"), { aliased, log }).admit(ex, {}),
        ).toEqual({ kind: "settled" });
        expect(rec.frames).toEqual(["error:NotSupported"]);
        expect(log).toEqual([
          expect.stringContaining("replied CallError(NotSupported)"),
        ]);
      }
    });
  });
});

describe("InboundCallGate response override modes", () => {
  function setup(aliased = false) {
    const rec: Recorder = { events: [], frames: [], timers: [] };
    const overrides = new CallOverrides();
    const cp = {
      notifyIncomingCall: () => {},
      getInboundCallPolicy: () => undefined,
      hasResponseOverride: (a: string) => overrides.hasResponseOverride(a),
      consumeResponse: (a: string) => overrides.consumeResponse(a),
      clearResponseOverride: (a: string) => overrides.clearResponseOverride(a),
    };
    const gate = new InboundCallGate({
      ports: aliased
        ? portsAliased(cp, new Set(["SetVariables"]))
        : ports16(cp),
      info: () => {},
      warn: () => {},
    });
    return { rec, overrides, gate };
  }

  it("callError carries the code, description and details", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", {
      mode: "callError",
      errorCode: "SecurityError",
      errorDescription: "nope",
      errorDetails: { why: 1 },
    });
    const ex = exchangeFor("Reset", rec);
    expect(gate.admit(ex, {})).toEqual({ kind: "settled" });
    expect(rec.frames).toEqual(['error:SecurityError:{"why":1}']);
    expect(rec.events).toEqual(["announce:CallError"]);
  });

  it("callResult writes the payload as given, schema-valid or not", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", { mode: "callResult", payload: { x: 1 } });
    gate.admit(exchangeFor("Reset", rec), {});
    expect(rec.frames).toEqual(['result:{"x":1}']);
  });

  it("raw writes the frame as given", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", { mode: "raw", frame: '[4,"m-1","X","y"]' });
    const ex = exchangeFor("Reset", rec);
    gate.admit(ex, {});
    expect(rec.frames).toEqual(['raw:[4,"m-1","X","y"]']);
    expect(rec.events).toEqual(["announce:CallError"]);
    expect(ex.state).toBe("answered");
  });

  it("callResultError writes a type 5 frame with the CALL's id", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", {
      mode: "callResultError",
      errorCode: "FormatViolation",
    });
    gate.admit(exchangeFor("Reset", rec), {});
    expect(rec.frames).toEqual(['raw:[5,"m-1","FormatViolation","",{}]']);
  });

  it("noAnswer suppresses the CALL", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", { mode: "noAnswer" });
    const ex = exchangeFor("Reset", rec);
    expect(gate.admit(ex, {})).toEqual({ kind: "settled" });
    expect(ex.state).toBe("suppressed");
    expect(rec.frames).toEqual([]);
  });

  it("delay lets the default path answer, with the write held back", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", { mode: "delay", delayMs: 250 });
    const ex = exchangeFor("Reset", rec);
    expect(gate.admit(ex, {})).toEqual({ kind: "default" });
    ex.reply({ status: "Accepted" });
    expect(rec.frames).toEqual([]);
    expect(rec.timers.map((t) => t.delayMs)).toEqual([250]);
    rec.timers[0].run();
    expect(rec.frames).toEqual(['result:{"status":"Accepted"}']);
  });

  it("delayMs on another mode holds that answer back", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", {
      mode: "status",
      status: "Rejected",
      delayMs: 40,
    });
    gate.admit(exchangeFor("Reset", rec), {});
    expect(rec.frames).toEqual([]);
    rec.timers[0].run();
    expect(rec.frames).toEqual(['result:{"status":"Rejected"}']);
  });

  it("times and persistent repeat an override; the default is one CALL", () => {
    const { rec, overrides, gate } = setup();
    overrides.armResponse("Reset", { mode: "noAnswer" }, { times: 2 });
    overrides.armResponse(
      "Heartbeat",
      { mode: "noAnswer" },
      { persistent: true },
    );
    for (let i = 0; i < 3; i++) {
      gate.admit(exchangeFor("Reset", rec), {});
      gate.admit(exchangeFor("Heartbeat", rec), {});
    }
    expect(overrides.hasResponseOverride("Reset")).toBe(false);
    expect(overrides.hasResponseOverride("Heartbeat")).toBe(true);
    // the third Reset reached the default path: nothing suppressed it
    expect(gate.admit(exchangeFor("Reset", rec), {})).toEqual({
      kind: "default",
    });
  });

  it("a non-status mode is honoured on an action whose answer is not { status }", () => {
    const { rec, overrides, gate } = setup(true);
    overrides.armResponse("SetVariables", {
      mode: "callResult",
      payload: { setVariableResult: [] },
    });
    gate.admit(exchangeFor("SetVariables", rec), {});
    expect(rec.frames).toEqual(['result:{"setVariableResult":[]}']);
  });
});
