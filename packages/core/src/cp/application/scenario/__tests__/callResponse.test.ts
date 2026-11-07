import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { resolveFromExchange } from "../resolveFrom";
import type {
  ScenarioCallExchange,
  ScenarioDefinition,
  ScenarioEvents,
  ScenarioExecutorCallbacks,
  ScenarioNode,
} from "../ScenarioTypes";
import { EventEmitter } from "../../../shared/EventEmitter";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";

const node = (id: string, type: string, data: object = {}): ScenarioNode =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  }) as unknown as ScenarioNode;

function definition(nodes: ScenarioNode[]): ScenarioDefinition {
  const edges = nodes
    .slice(1)
    .map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id }));
  return {
    id: "s",
    name: "s",
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

async function run(
  def: ScenarioDefinition,
  callbacks: ScenarioExecutorCallbacks,
): Promise<{ state: string; error?: string }> {
  const events = new EventEmitter<ScenarioEvents>();
  let result: { state: string; error?: string } = { state: "running" };
  events.on("execution.completed", () => {
    result = { state: "completed" };
  });
  events.on("execution.error", (info) => {
    result = { state: "error", error: (info as { error: string }).error };
  });
  await new ScenarioExecutor(def, callbacks, events).start();
  return result;
}

const exchangeOf = (
  settlement: { delivered: true } | { delivered: false; reason: string },
): ScenarioCallExchange => ({
  action: "Reset",
  messageId: "m1",
  payload: { type: "Soft" },
  answer: vi.fn(() => Promise.resolve(settlement)),
});

describe("callResponse settlement", () => {
  const trigger = node("t", "csmsCallTrigger", {
    action: "Reset",
    behavior: "replace",
  });
  const respond = node("r", "callResponse", { kind: "result", payload: {} });

  it("a send that failed or was dropped fails the run with the reason", async () => {
    const answer = exchangeOf({ delivered: false, reason: "queue_overflow" });
    const outcome = await run(
      definition([node("start", "start"), trigger, respond]),
      {
        onWaitForCsmsCall: () =>
          Promise.resolve({ action: "Reset", payload: {}, exchange: answer }),
      },
    );
    expect(outcome.state).toBe("error");
    expect(outcome.error).toContain("not delivered (queue_overflow)");
  });

  it("a delivered answer completes the run", async () => {
    const answer = exchangeOf({ delivered: true });
    const outcome = await run(
      definition([node("start", "start"), trigger, respond]),
      {
        onWaitForCsmsCall: () =>
          Promise.resolve({ action: "Reset", payload: {}, exchange: answer }),
      },
    );
    expect(outcome.state).toBe("completed");
    expect(answer.answer).toHaveBeenCalledWith({ kind: "result", payload: {} });
  });

  it("a station that cannot hand over the CALL fails the run", async () => {
    const outcome = await run(
      definition([node("start", "start"), trigger, respond]),
      {
        onWaitForCsmsCall: () =>
          Promise.resolve({ action: "Reset", payload: {} }),
      },
    );
    expect(outcome.state).toBe("error");
    expect(outcome.error).toContain('behavior "replace" is not available');
  });
});

describe("csmsCallTrigger replace on SOAP", () => {
  it("fails when the node arms, it never falls back to the default behavior", async () => {
    const chargePoint = {
      isSoapChargePoint: () => true,
      ocppVersion: "OCPP-1.5",
      canReceiveCsmsCall: () => true,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ChargePoint;
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector: { id: 1 } as unknown as Connector,
    });
    await expect(
      callbacks.onWaitForCsmsCall!("Reset", undefined, {
        scenarioId: "s",
        nodeId: "n",
      }),
    ).rejects.toThrow(/needs an OCPP-J station; OCPP-1\.5 is SOAP/);
  });
});

describe("resolveFromExchange", () => {
  const exchange: ScenarioCallExchange = {
    action: "UpdateFirmware",
    messageId: "m7",
    payload: { requestId: 5, items: [{ id: "a" }], nested: { deep: true } },
    answer: () => Promise.resolve({ delivered: true }),
  };

  it("replaces whole values anywhere in the payload and leaves the rest", () => {
    expect(
      resolveFromExchange(
        {
          a: { $from: "call.payload.requestId" },
          b: [{ $from: "call.payload.items.0.id" }, 1],
          c: { $from: "call.action" },
          d: { $from: "call.messageId" },
          e: { $from: "call.payload.nested" },
          keep: "call.payload.requestId",
        },
        exchange,
        "t",
      ),
    ).toEqual({
      a: 5,
      b: ["a", 1],
      c: "UpdateFirmware",
      d: "m7",
      e: { deep: true },
      keep: "call.payload.requestId",
    });
  });

  it("does not treat an object with other keys as a reference", () => {
    expect(
      resolveFromExchange(
        { $from: "call.payload.requestId", x: 1 },
        exchange,
        "t",
      ),
    ).toEqual({ $from: "call.payload.requestId", x: 1 });
  });

  it("fails on a missing path, a wrong root and a missing CALL", () => {
    expect(() =>
      resolveFromExchange({ $from: "call.payload.nope" }, exchange, "t"),
    ).toThrow(/names nothing/);
    expect(() =>
      resolveFromExchange({ $from: "payload.requestId" }, exchange, "t"),
    ).toThrow(/must start with "call\."/);
    expect(() =>
      resolveFromExchange({ $from: "call.payload.requestId" }, null, "t"),
    ).toThrow(/needs a CALL/);
  });
});
