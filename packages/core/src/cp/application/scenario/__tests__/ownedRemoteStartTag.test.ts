import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioExecutorCallbacks } from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/**
 * A `csmsCallTrigger` with `behavior: "replace"` that takes a
 * RemoteStartTransaction / RequestStartTransaction is still a remote start:
 * the next Start Transaction node carries the tag the CSMS sent, as after a
 * `remoteStartTrigger`. Before, the owned CALL captured nothing and the start
 * used the station's default tag.
 */
async function startedWith(
  action: string,
  payload: unknown,
  nodeTag?: string,
): Promise<{ tag: string; options: unknown }> {
  const onStartTransaction = vi.fn().mockResolvedValue({ started: true });
  const callbacks: ScenarioExecutorCallbacks = {
    onWaitForCsmsCall: () =>
      Promise.resolve({
        action,
        payload,
        exchange: {
          action,
          messageId: "m1",
          payload,
          answer: () => Promise.reject(new Error("not answered in this test")),
        },
      }),
    onStartTransaction,
    onResolveIdTag: () => "POOL-TAG",
  } as ScenarioExecutorCallbacks;
  const scenario = linearScenario("owned-remote-start", [
    node("own", ScenarioNodeType.CSMS_CALL_TRIGGER, {
      label: "Own",
      action,
      behavior: "replace",
    }),
    node("start-tx", ScenarioNodeType.TRANSACTION, {
      label: "Start",
      action: "start",
      ...(nodeTag ? { tagId: nodeTag } : {}),
    }),
  ]);
  await new ScenarioExecutor(scenario, callbacks).start();
  expect(onStartTransaction).toHaveBeenCalledTimes(1);
  const args = onStartTransaction.mock.calls[0]!;
  return { tag: args[0] as string, options: args[3] };
}

describe("an owned remote start supplies the tag of the next Start Transaction", () => {
  it("1.6 RemoteStartTransaction: idTag", async () => {
    const started = await startedWith("RemoteStartTransaction", {
      connectorId: 1,
      idTag: "DEMO-TAG-2",
    });
    expect(started.tag).toBe("DEMO-TAG-2");
    expect(started.options).toEqual({ triggerReason: "RemoteStart" });
  });

  it("2.x RequestStartTransaction: idToken, its type and the remote start id", async () => {
    const started = await startedWith("RequestStartTransaction", {
      remoteStartId: 7,
      idToken: { idToken: "DEMO-TAG-2", type: "ISO14443" },
    });
    expect(started.tag).toBe("DEMO-TAG-2");
    expect(started.options).toEqual({
      triggerReason: "RemoteStart",
      remoteStartId: 7,
      idTokenType: "ISO14443",
    });
  });

  it("another action leaves the node's own tag and the pool alone", async () => {
    const started = await startedWith("Reset", { type: "Soft" }, "NODE-TAG");
    expect(started.tag).toBe("NODE-TAG");
  });
});
