import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNodeData,
  ScenarioNodeType,
  ScenarioWaitIntervention,
} from "../ScenarioTypes";
import { cancellablePromise } from "../cancellable";
import { deferred, type Deferred } from "../../../../test/deferred";
import { linearScenario, node } from "./scenarioFixtures";

function remoteStartThenStart(timeout: number): ScenarioDefinition {
  return linearScenario("wait-controls", [
    node("remote-start", ScenarioNodeType.REMOTE_START_TRIGGER, {
      label: "Wait RemoteStart",
      timeout,
    }),
    node("tx-start", ScenarioNodeType.TRANSACTION, {
      label: "Start Transaction",
      action: "start",
      tagId: "NODE-TAG",
    }),
  ]);
}

/** A remote-start callback whose every arm is a held-open, cancellable wait. */
function armableRemoteStart() {
  const arms: Array<{
    wait: Deferred<string>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const onWaitForRemoteStart = vi.fn(() => {
    const wait = deferred<string>();
    const cancel = vi.fn();
    arms.push({ wait, cancel });
    return cancellablePromise({ promise: wait.promise, cancel });
  });
  return { arms, onWaitForRemoteStart };
}

describe("ScenarioExecutor wait controls (#240)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("owns the trigger deadline: the runtime wait takes no timeout", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const executor = new ScenarioExecutor(remoteStartThenStart(5), {
      onWaitForRemoteStart,
      onStartTransaction: vi.fn(async () => {}),
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onWaitForRemoteStart).toHaveBeenCalledWith();
    expect(executor.getContext()).toMatchObject({
      state: "waiting",
      waitDeadlineAt: Date.now() + 5_000,
    });

    arms[0]!.wait.resolve("TAG");
    await run;
  });

  it("fails the run with the node's timeout message when the deadline passes", async () => {
    const { onWaitForRemoteStart } = armableRemoteStart();
    const onError = vi.fn();
    const executor = new ScenarioExecutor(remoteStartThenStart(2), {
      onWaitForRemoteStart,
      onError,
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timeout waiting for remote start (2s)",
      }),
    );
    expect(executor.getContext().state).toBe("error");
  });

  it("keeps the payload wording of a CSMS-call timeout", async () => {
    const onError = vi.fn();
    const executor = new ScenarioExecutor(
      linearScenario("wait-controls", [
        node("call", ScenarioNodeType.CSMS_CALL_TRIGGER, {
          label: "Wait Reset",
          action: "Reset",
          payload: { type: "Hard" },
          timeout: 1,
        }),
      ]),
      {
        onWaitForCsmsCall: () =>
          new Promise<{ action: string; payload: unknown }>(() => {}),
        onError,
      },
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timeout waiting for CSMS call Reset matching payload (1s)",
      }),
    );
  });

  it("extendWait postpones the deadline and reports the effective total", async () => {
    const { onWaitForRemoteStart } = armableRemoteStart();
    const onError = vi.fn();
    const executor = new ScenarioExecutor(remoteStartThenStart(2), {
      onWaitForRemoteStart,
      onError,
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_500);
    executor.extendWait(5);

    expect(executor.getContext().waitDeadlineAt).toBe(Date.now() + 5_500);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onError).not.toHaveBeenCalled();
    expect(executor.getContext().state).toBe("waiting");

    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timeout waiting for remote start (7s)",
      }),
    );
  });

  it("retryWait withdraws the wait, re-arms it and restarts the full timeout", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const onStartTransaction = vi.fn(async () => {});
    const executor = new ScenarioExecutor(remoteStartThenStart(10), {
      onWaitForRemoteStart,
      onStartTransaction,
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(4_000);
    executor.retryWait();
    await vi.advanceTimersByTimeAsync(0);

    expect(onWaitForRemoteStart).toHaveBeenCalledTimes(2);
    expect(arms[0]!.cancel).toHaveBeenCalled();
    expect(executor.getContext()).toMatchObject({
      state: "waiting",
      currentNodeId: "remote-start",
      currentNodeStartedAt: Date.now(),
      waitDeadlineAt: Date.now() + 10_000,
    });

    // A late answer to the withdrawn arm must not leak into the run.
    arms[0]!.wait.resolve("STALE-TAG");
    arms[1]!.wait.resolve("FRESH-TAG");
    await run;

    expect(onStartTransaction).toHaveBeenCalledWith(
      "FRESH-TAG",
      undefined,
      undefined,
      { triggerReason: "RemoteStart" },
    );
    expect(executor.getContext().state).toBe("completed");
  });

  it("continueWait moves on without the awaited event", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const onStartTransaction = vi.fn(async () => {});
    const executor = new ScenarioExecutor(remoteStartThenStart(10), {
      onWaitForRemoteStart,
      onStartTransaction,
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    executor.continueWait();
    await run;

    expect(arms[0]!.cancel).toHaveBeenCalled();
    // No RemoteStart tag was captured, so the Transaction node's own tag wins.
    expect(onStartTransaction).toHaveBeenCalledWith(
      "NODE-TAG",
      undefined,
      undefined,
    );
    expect(executor.getContext().state).toBe("completed");
  });

  it("a continued RemoteStop wait drops an earlier stop's captured reason", async () => {
    const onStopTransaction = vi.fn(async () => {});
    const onWaitForRemoteStop = vi
      .fn()
      .mockResolvedValueOnce({ transactionId: 1, reason: "Remote" })
      .mockReturnValueOnce(new Promise(() => {}));
    const executor = new ScenarioExecutor(
      linearScenario("wait-controls", [
        node("remote-stop-1", ScenarioNodeType.REMOTE_STOP_TRIGGER, {
          label: "First RemoteStop",
          timeout: 0,
        }),
        node("remote-stop-2", ScenarioNodeType.REMOTE_STOP_TRIGGER, {
          label: "Second RemoteStop",
          timeout: 0,
        }),
        node("tx-stop", ScenarioNodeType.TRANSACTION, {
          label: "Stop Transaction",
          action: "stop",
          stopReason: "EVDisconnected",
        }),
      ]),
      { onWaitForRemoteStop, onStopTransaction },
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.getContext().currentNodeId).toBe("remote-stop-2");
    executor.continueWait();
    await run;

    expect(onStopTransaction).toHaveBeenCalledWith("EVDisconnected");
  });

  it("continueWait also releases a wait that has no timeout", async () => {
    const executor = new ScenarioExecutor(
      linearScenario("wait-controls", [
        node("status", ScenarioNodeType.STATUS_TRIGGER, {
          label: "Wait Charging",
          targetStatus: "Charging",
          timeout: 0,
        } as ScenarioNodeData),
      ]),
      { onWaitForStatus: () => new Promise<void>(() => {}) },
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.getContext()).toMatchObject({
      state: "waiting",
      waitDeadlineAt: null,
    });
    expect(() => executor.extendWait(30)).toThrow(/no timeout/);

    executor.continueWait();
    await run;
    expect(executor.getContext().state).toBe("completed");
  });

  it("hands the controls back to a parallel branch's wait once the other settles", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const status = deferred<void>();
    const nodes = [
      node("start", ScenarioNodeType.START, { label: "Start" }),
      node("remote-start", ScenarioNodeType.REMOTE_START_TRIGGER, {
        label: "Wait RemoteStart",
        timeout: 60,
      }),
      node("status", ScenarioNodeType.STATUS_TRIGGER, {
        label: "Wait Charging",
        targetStatus: "Charging",
        timeout: 0,
      } as ScenarioNodeData),
    ];
    const executor = new ScenarioExecutor(
      {
        ...linearScenario("wait-controls", []),
        nodes,
        edges: [
          { id: "e-a", source: "start", target: "remote-start" },
          { id: "e-b", source: "start", target: "status" },
        ],
      },
      { onWaitForRemoteStart, onWaitForStatus: () => status.promise },
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    // Both branches are parked; the controls act on the latest-armed wait.
    expect(executor.getContext().waitDeadlineAt).toBeNull();

    status.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // The RemoteStart wait is still parked and reachable again.
    expect(executor.getContext().waitDeadlineAt).toBe(Date.now() + 60_000);
    executor.continueWait();
    await run;

    expect(arms[0]!.cancel).toHaveBeenCalled();
    expect(executor.getContext().state).toBe("completed");
  });

  it("refuses every control when no wait is parked", async () => {
    const executor = new ScenarioExecutor(
      linearScenario("wait-controls", [
        node("delay", ScenarioNodeType.DELAY, {
          label: "Delay",
          delaySeconds: 5,
        }),
      ]),
      {},
    );

    expect(() => executor.extendWait(30)).toThrow(/is not waiting/);

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => executor.retryWait()).toThrow(/is not waiting/);
    expect(() => executor.continueWait()).toThrow(/is not waiting/);

    executor.stop();
    await run;
  });

  it("reports every intervention through onWaitIntervention", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const interventions: ScenarioWaitIntervention[] = [];
    const callbacks: ScenarioExecutorCallbacks = {
      onWaitForRemoteStart,
      onStartTransaction: vi.fn(async () => {}),
      onWaitIntervention: (intervention) => interventions.push(intervention),
    };
    const executor = new ScenarioExecutor(remoteStartThenStart(10), callbacks);

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    executor.extendWait(30);
    executor.retryWait();
    await vi.advanceTimersByTimeAsync(0);
    executor.continueWait();
    await run;

    expect(arms).toHaveLength(2);
    expect(interventions).toEqual([
      { kind: "extend", nodeId: "remote-start", at: Date.now(), seconds: 30 },
      { kind: "retry", nodeId: "remote-start", at: Date.now() },
      { kind: "continue", nodeId: "remote-start", at: Date.now() },
    ]);
  });

  it("clears the deadline from the context once the wait settles", async () => {
    const { arms, onWaitForRemoteStart } = armableRemoteStart();
    const executor = new ScenarioExecutor(remoteStartThenStart(10), {
      onWaitForRemoteStart,
      onStartTransaction: vi.fn(async () => {}),
    });

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    arms[0]!.wait.resolve("TAG");
    await run;

    expect(executor.getContext().waitDeadlineAt).toBeNull();
  });
});
