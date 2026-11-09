import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNode,
} from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/** The root `response` (schema 1.7): the answer to the latest ocppCall. */

type Wiring = Array<[string, string] | [string, string, string]>;

function graph(nodes: ScenarioNode[], wiring: Wiring): ScenarioDefinition {
  return {
    ...linearScenario("response", []),
    nodes,
    edges: wiring.map(([source, target, sourceHandle], index) => ({
      id: `e${index}`,
      source,
      target,
      ...(sourceHandle === undefined ? {} : { sourceHandle }),
    })),
  };
}

const start = () => node("start", ScenarioNodeType.START, { label: "Start" });
const call = (
  id: string,
  action: string,
  payload: Record<string, unknown> = {},
) => node(id, ScenarioNodeType.OCPP_CALL, { label: id, action, payload });
const mark = (id: string) =>
  node(id, ScenarioNodeType.SET_STATE, { label: id, key: id, value: true });
const sw = (id: string, from: string, cases: unknown[]) =>
  node(id, ScenarioNodeType.SWITCH, {
    label: id,
    value: { $from: from },
    cases,
  });

const result = (payload: unknown) => ({
  kind: "callResult" as const,
  messageId: "m1",
  sentFrame: "[]",
  payload,
});
const callError = {
  kind: "callError" as const,
  messageId: "m2",
  sentFrame: "[]",
  errorCode: "NotSupported",
  errorDescription: "no",
  errorDetails: { why: "test" },
};

async function run(
  scenario: ScenarioDefinition,
  onSendOcppCall: ScenarioExecutorCallbacks["onSendOcppCall"],
) {
  const logs: string[] = [];
  const errors: Error[] = [];
  const executor = new ScenarioExecutor(scenario, {
    onSendOcppCall,
    log: (m) => logs.push(m),
    onError: (e) => errors.push(e),
  });
  await executor.start();
  return { logs, errors, executor };
}

describe("$from response (schema 1.7)", () => {
  it("branches on the idTagInfo.status of an Authorize CALLRESULT", async () => {
    const scenario = graph(
      [
        start(),
        call("auth", "Authorize", { idTag: "TAG-1" }),
        sw("sw", "response.payload.idTagInfo.status", ["Accepted", "Blocked"]),
        mark("accepted"),
        mark("blocked"),
      ],
      [
        ["start", "auth"],
        ["auth", "sw"],
        ["sw", "accepted", "case-0"],
        ["sw", "blocked", "case-1"],
      ],
    );
    const send = vi
      .fn()
      .mockResolvedValue(result({ idTagInfo: { status: "Blocked" } }));
    const { logs, errors, executor } = await run(scenario, send);
    expect(errors).toEqual([]);
    expect(logs).toContain('Switch on "Blocked" → case-1');
    expect(executor.getContext().state).toBe("completed");
    expect(executor.getContext().state).not.toBe("error");
  });

  it("reads kind, action, messageId and payload of a result", async () => {
    const scenario = graph(
      [
        start(),
        call("auth", "Authorize"),
        node("a", ScenarioNodeType.SET_STATE, {
          label: "a",
          key: "answer",
          value: { $from: "response.kind" },
        }),
        node("b", ScenarioNodeType.SET_STATE, {
          label: "b",
          key: "id",
          value: { $from: "response.messageId" },
        }),
        node("c", ScenarioNodeType.SET_STATE, {
          label: "c",
          key: "action",
          value: { $from: "response.action" },
        }),
      ],
      [
        ["start", "auth"],
        ["auth", "a"],
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const { errors, executor } = await run(
      scenario,
      vi.fn().mockResolvedValue(result({ idTagInfo: { status: "Accepted" } })),
    );
    expect(errors).toEqual([]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("exposes a CALLERROR as kind error with errorCode, description and details", async () => {
    const scenario = graph(
      [
        start(),
        call("auth", "Authorize"),
        sw("kind", "response.kind", ["result", "error"]),
        sw("code", "response.errorCode", ["GenericError", "NotSupported"]),
        mark("hit"),
        mark("miss"),
      ],
      [
        ["start", "auth"],
        ["auth", "kind"],
        ["kind", "code", "case-1"],
        ["kind", "miss", "case-0"],
        ["code", "hit", "case-1"],
      ],
    );
    const { logs, errors } = await run(
      scenario,
      vi.fn().mockResolvedValue(callError),
    );
    expect(errors).toEqual([]);
    expect(logs).toContain('Switch on "error" → case-1');
    expect(logs).toContain('Switch on "NotSupported" → case-1');
  });

  it("an error has no payload and a result has no errorCode: the run fails", async () => {
    const scenario = (path: string) =>
      graph(
        [start(), call("c", "Authorize"), sw("sw", path, [1])],
        [
          ["start", "c"],
          ["c", "sw"],
        ],
      );
    const onError = await run(
      scenario("response.payload.idTagInfo"),
      vi.fn().mockResolvedValue(callError),
    );
    expect(onError.errors[0]?.message).toContain(
      '$from "response.payload.idTagInfo" names nothing in the Authorize answer',
    );
    const onResult = await run(
      scenario("response.errorCode"),
      vi.fn().mockResolvedValue(result({})),
    );
    expect(onResult.errors[0]?.message).toContain("names nothing");
  });

  it("fails the run with a clear message when no ocppCall answered in the branch", async () => {
    const scenario = graph(
      [start(), sw("sw", "response.kind", ["result"])],
      [["start", "sw"]],
    );
    const { errors, executor } = await run(scenario, vi.fn());
    expect(executor.getContext().state).toBe("error");
    expect(errors[0]?.message).toBe(
      'switch: $from "response.kind" needs the answer to an ocppCall earlier in this branch',
    );
  });

  it("latest answer wins", async () => {
    const scenario = graph(
      [
        start(),
        call("first", "Authorize"),
        call("second", "Heartbeat"),
        sw("sw", "response.action", ["Authorize", "Heartbeat"]),
        mark("a"),
        mark("b"),
      ],
      [
        ["start", "first"],
        ["first", "second"],
        ["second", "sw"],
      ],
    );
    const { logs } = await run(scenario, vi.fn().mockResolvedValue(result({})));
    expect(logs).toContain('Switch on "Heartbeat" → case-1');
  });

  it("resolves a response in the payload of the next ocppCall", async () => {
    const scenario = graph(
      [
        start(),
        call("first", "StartTransaction"),
        call("second", "StopTransaction", {
          transactionId: { $from: "response.payload.transactionId" },
        }),
      ],
      [
        ["start", "first"],
        ["first", "second"],
      ],
    );
    const send = vi
      .fn()
      .mockResolvedValueOnce(result({ transactionId: 42 }))
      .mockResolvedValueOnce(result({}));
    const { errors } = await run(scenario, send);
    expect(errors).toEqual([]);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "StopTransaction",
        payload: { transactionId: 42 },
      }),
    );
  });

  it("parallel branches from Start keep separate answers", async () => {
    const scenario = graph(
      [
        start(),
        call("a", "Authorize"),
        call("b", "Heartbeat"),
        node("sa", ScenarioNodeType.SET_STATE, {
          label: "sa",
          key: "fromA",
          value: { $from: "response.action" },
        }),
        node("sb", ScenarioNodeType.SET_STATE, {
          label: "sb",
          key: "fromB",
          value: { $from: "response.action" },
        }),
        node("seen", ScenarioNodeType.SWITCH, {
          label: "seen",
          value: { $from: "state.fromA" },
          cases: ["Authorize"],
        }),
        node("seen2", ScenarioNodeType.SWITCH, {
          label: "seen2",
          value: { $from: "state.fromB" },
          cases: ["Heartbeat"],
        }),
      ],
      [
        ["start", "a"],
        ["start", "b"],
        ["a", "sa"],
        ["b", "sb"],
        ["sa", "seen"],
        ["sb", "seen2"],
      ],
    );
    const send = vi
      .fn()
      .mockImplementation(async ({ action }: { action: string }) =>
        result({ action }),
      );
    const { logs, errors } = await run(scenario, send);
    expect(errors).toEqual([]);
    expect(logs).toContain('Switch on "Authorize" → case-0');
    expect(logs).toContain('Switch on "Heartbeat" → case-0');
  });
});
