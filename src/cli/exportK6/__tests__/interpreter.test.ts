// src/cli/exportK6/__tests__/interpreter.test.ts
import { describe, expect, it, vi } from "vitest";
import { runScenario, type ScenarioHost } from "../runtime/interpreter";
import { wire16 } from "../runtime/wire/v16";
import type { ScenarioJson, WireCall } from "../runtime/types";

class FakeHost implements ScenarioHost {
  connectorId = 1;
  sent: WireCall[] = [];
  status = "Available";
  overrides: Array<[string, string]> = [];
  configs: Array<[string, string]> = [];
  unlock: string | null = null;
  /** Scripted responses by action; default {} */
  responses = new Map<string, Record<string, unknown>>();
  /** Pending incoming-call waiters, resolved via emitCsmsCall(). */
  private waiters: Array<{
    actions: readonly string[];
    resolve: (v: { action: string; payload: Record<string, unknown> }) => void;
  }> = [];
  slept: number[] = [];

  async call(c: WireCall): Promise<Record<string, unknown>> {
    this.sent.push(c);
    return this.responses.get(c.action) ?? {};
  }
  waitForCsmsCall(actions: readonly string[], _timeoutMs: number | null) {
    return new Promise<{ action: string; payload: Record<string, unknown> }>(
      (resolve) => this.waiters.push({ actions, resolve }),
    );
  }
  emitCsmsCall(action: string, payload: Record<string, unknown>): void {
    const i = this.waiters.findIndex((w) => w.actions.includes(action));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve({ action, payload });
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    // Yield a real macrotask instead of resolving on the microtask queue.
    // This lets the main walk and a background auto-meter loop take turns
    // (each sleep is a discrete "tick") instead of one starving the other
    // via an unbroken chain of microtasks — needed for the finally-stop test
    // below, where the loop would otherwise spin forever ahead of the walk
    // ever reaching runScenario's `finally`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  nowIso(): string {
    return "2026-07-29T00:00:00.000Z";
  }
  getLocalStatus(): string {
    return this.status;
  }
  setLocalStatus(status: string): void {
    this.status = status;
  }
  async waitForLocalStatus(): Promise<void> {}
  armResponseOverride(action: string, status: string): void {
    this.overrides.push([action, status]);
  }
  setUnlockOutcome(outcome: string): void {
    this.unlock = outcome;
  }
  setLocalConfig(key: string, value: string): void {
    this.configs.push([key, value]);
  }
}

function scenario(
  nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }>,
  edges: Array<[string, string]>,
): ScenarioJson {
  return {
    id: "s",
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: n.data ?? { label: n.id },
    })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

describe("runScenario", () => {
  it("walks a sequential charge flow and tracks the transaction id", async () => {
    const host = new FakeHost();
    host.responses.set("StartTransaction", {
      transactionId: 42,
      idTagInfo: { status: "Accepted" },
    });
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "statusChange", data: { status: "Preparing" } },
        { id: "c", type: "transaction", data: { action: "start", tagId: "T" } },
        {
          id: "d",
          type: "meterValue",
          data: { value: 1000, sendMessage: true },
        },
        {
          id: "e",
          type: "transaction",
          data: { action: "stop", stopReason: "Local" },
        },
        { id: "f", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "e"],
        ["e", "f"],
      ],
    );
    const result = await runScenario(host, wire16, s);
    expect(result).toEqual({ completed: true, steps: 5 });
    expect(host.sent.map((c) => c.action)).toEqual([
      "StatusNotification", // Preparing
      "StartTransaction",
      "StatusNotification", // Charging (implicit on start)
      "MeterValues",
      "StopTransaction",
      "StatusNotification", // Finishing (implicit on stop)
    ]);
    const stop = host.sent.find((c) => c.action === "StopTransaction");
    expect(stop?.payload.transactionId).toBe(42);
    expect(stop?.payload.meterStop).toBe(1000);
    expect(stop?.payload.reason).toBe("Local");
  });

  it("delay sleeps for delaySeconds", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "delay", data: { delaySeconds: 3 } },
        { id: "c", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    await runScenario(host, wire16, s);
    expect(host.slept).toEqual([3000]);
  });

  it("remoteStartTrigger waits and feeds the idTag into transaction start", async () => {
    const host = new FakeHost();
    host.responses.set("StartTransaction", {
      transactionId: 1,
      idTagInfo: { status: "Accepted" },
    });
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "remoteStartTrigger", data: {} },
        { id: "c", type: "transaction", data: { action: "start" } },
        { id: "d", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
      ],
    );
    const run = runScenario(host, wire16, s);
    host.emitCsmsCall("RemoteStartTransaction", { idTag: "REMOTE-1" });
    await run;
    const start = host.sent.find((c) => c.action === "StartTransaction");
    expect(start?.payload.idTag).toBe("REMOTE-1");
  });

  it("runs parallel branches and joins before finishing", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "dataTransfer", data: { vendorId: "v1" } },
        { id: "c", type: "dataTransfer", data: { vendorId: "v2" } },
      ],
      [
        ["a", "b"],
        ["a", "c"],
      ],
    );
    const result = await runScenario(host, wire16, s);
    expect(result.completed).toBe(true);
    expect(host.sent.map((c) => c.payload.vendorId).sort()).toEqual([
      "v1",
      "v2",
    ]);
  });

  it("applies armed nodes to the host", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "unlockOutcome", data: { outcome: "UnlockFailed" } },
        {
          id: "c",
          type: "responseOverride",
          data: { action: "Reset", status: "Rejected" },
        },
        { id: "d", type: "configSet", data: { key: "K", value: "V" } },
        { id: "e", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "e"],
      ],
    );
    await runScenario(host, wire16, s);
    expect(host.unlock).toBe("UnlockFailed");
    expect(host.overrides).toEqual([["Reset", "Rejected"]]);
    expect(host.configs).toEqual([["K", "V"]]);
  });

  it("auto-increment meter stops at maxValue and sends each tick", async () => {
    // Park the walk on a csmsCallTrigger so the background meter loop runs to
    // its own maxValue stop condition — no dependence on microtask ordering
    // between the walk and the loop.
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        {
          id: "b",
          type: "meterValue",
          data: {
            value: 0,
            sendMessage: true,
            autoIncrement: true,
            incrementInterval: 1,
            incrementAmount: 500,
            stopMode: "manual",
            maxValue: 1000,
          },
        },
        { id: "c", type: "csmsCallTrigger", data: { action: "Ping" } },
        { id: "d", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
      ],
    );
    const run = runScenario(host, wire16, s);
    const meterCalls = () =>
      host.sent.filter((c) => c.action === "MeterValues");
    // value=0 with sendMessage sends once immediately, then 2 ticks reach maxValue=1000.
    await vi.waitFor(() => expect(meterCalls().length).toBe(3));
    host.emitCsmsCall("Ping", {});
    const result = await run;
    expect(result.completed).toBe(true);
    const values = meterCalls().map(
      (c) =>
        (
          c.payload.meterValue as Array<{
            sampledValue: Array<{ value: string }>;
          }>
        )[0].sampledValue[0].value,
    );
    expect(values).toEqual(["0", "500", "1000"]);
  });

  it("stops a still-running auto-meter loop when the scenario ends", async () => {
    // Unlike the maxValue test above (which parks the walk until the loop
    // self-terminates), this loop has no maxTime/maxValue/curve and would
    // run forever unless runScenario's `finally` actively stops it. If the
    // finally-stop path were broken, this test would hang instead of
    // resolving — that hang IS the assertion.
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        {
          id: "b",
          type: "meterValue",
          data: {
            value: 0,
            sendMessage: false,
            autoIncrement: true,
            incrementInterval: 1,
            incrementAmount: 100,
            stopMode: "manual",
            // no maxTime/maxValue: the loop would run forever unless stopped
          },
        },
        { id: "c", type: "delay", data: { delaySeconds: 0 } },
        { id: "d", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
      ],
    );
    const result = await runScenario(host, wire16, s);
    expect(result.completed).toBe(true); // resolving at all proves the finally stopped the loop
  });

  it("errors on transaction stop without an active transaction", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "transaction", data: { action: "stop" } },
        { id: "c", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const result = await runScenario(host, wire16, s);
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/transaction/i);
  });

  it("guards against infinite cycles with maxSteps", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        { id: "b", type: "delay", data: { delaySeconds: 0 } },
        { id: "c", type: "delay", data: { delaySeconds: 0 } },
      ],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "b"],
      ],
    );
    const result = await runScenario(host, wire16, s, { maxSteps: 10 });
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/steps/);
  });

  it("sends {} for a notification node with a non-object payload", async () => {
    const host = new FakeHost();
    const s = scenario(
      [
        { id: "a", type: "start" },
        {
          id: "b",
          type: "notification",
          data: { messageType: "DataTransfer", payload: "not-an-object" },
        },
        { id: "c", type: "end" },
      ],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    await runScenario(host, wire16, s);
    const sent = host.sent.find((c) => c.action === "DataTransfer");
    expect(sent?.payload).toEqual({});
  });

  it("errors when the scenario has no start node", async () => {
    const host = new FakeHost();
    const result = await runScenario(
      host,
      wire16,
      scenario([{ id: "x", type: "end" }], []),
    );
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/start/);
  });
});
