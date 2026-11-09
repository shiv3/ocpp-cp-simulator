/**
 * Schema 1.8: an edge with `kind: "timeout"` out of a trigger wait runs when
 * the wait's timeout expires, instead of failing the run. Every other walk
 * (the first edge of a step, Start's fan-out, a switch / choice handle)
 * ignores it, and a wait without one fails on its timeout as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNode,
} from "../ScenarioTypes";

type ScenarioEdge = ScenarioDefinition["edges"][number];

const node = (id: string, type: string, data: object = {}): ScenarioNode =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  }) as unknown as ScenarioNode;

const edge = (
  source: string,
  target: string,
  extra: Record<string, unknown> = {},
): ScenarioEdge =>
  ({
    id: `${source}>${target}${extra.kind ? ":timeout" : ""}`,
    source,
    target,
    ...extra,
  }) as ScenarioEdge;

const timeoutEdge = (source: string, target: string) =>
  edge(source, target, { kind: "timeout" });

const scenario = (
  nodes: ScenarioNode[],
  edges: ScenarioEdge[],
): ScenarioDefinition => ({
  id: "timeout-edges",
  name: "timeout-edges",
  targetType: "connector",
  targetId: 1,
  nodes,
  edges,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** A status wait that never answers, and a status change that records. */
function harness(extra: Partial<ScenarioExecutorCallbacks> = {}) {
  const statuses: string[] = [];
  const logs: string[] = [];
  const onError = vi.fn();
  const callbacks: ScenarioExecutorCallbacks = {
    onWaitForStatus: () => new Promise<void>(() => {}),
    onStatusChange: async (status) => {
      statuses.push(status);
    },
    log: (message) => {
      logs.push(message);
    },
    onError,
    ...extra,
  };
  return { statuses, logs, onError, callbacks };
}

const waitNode = (timeout?: number) =>
  node("wait", "statusTrigger", {
    targetStatus: "Charging",
    ...(timeout === undefined ? {} : { timeout }),
  });
const mark = (id: string) => node(id, "statusChange", { status: id });

describe("timeout edges (schema 1.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a statusTrigger that times out goes on along its timeout edge and the run completes", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(2), mark("Normal"), mark("Late")],
        [
          edge("start", "wait"),
          edge("wait", "Normal"),
          timeoutEdge("wait", "Late"),
        ],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.statuses).toEqual([]);
    expect(executor.getContext().state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["Late"]);
    expect(executor.getContext().state).toBe("completed");
    expect(executor.getContext().executedNodes).toEqual([
      "start",
      "wait",
      "Late",
    ]);
    expect(h.logs).toContainEqual(
      expect.stringContaining(
        'Timeout waiting for status: Charging (2s); "wait" goes on along its timeout edge to "Late"',
      ),
    );
  });

  it("without a timeout edge the run fails on the timeout as before", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(2), mark("Normal")],
        [edge("start", "wait"), edge("wait", "Normal")],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Timeout waiting for status: Charging (2s)",
      }),
    );
    expect(h.statuses).toEqual([]);
    expect(executor.getContext().state).toBe("error");
  });

  it("the first timeout edge to an existing node runs; the others never do", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(1), mark("First"), mark("Second")],
        [
          edge("start", "wait"),
          timeoutEdge("wait", "missing"),
          timeoutEdge("wait", "First"),
          timeoutEdge("wait", "Second"),
        ],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.statuses).toEqual(["First"]);
  });

  it("a satisfied wait takes its ordinary edge, never the timeout edge listed first", async () => {
    const h = harness({ onWaitForStatus: () => Promise.resolve() });
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(2), mark("Normal"), mark("Late")],
        [
          edge("start", "wait"),
          timeoutEdge("wait", "Late"),
          edge("wait", "Normal"),
        ],
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual(["Normal"]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("a wait with only a timeout edge ends its branch when satisfied", async () => {
    const h = harness({ onWaitForStatus: () => Promise.resolve() });
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(2), mark("Late")],
        [edge("start", "wait"), timeoutEdge("wait", "Late")],
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual([]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("a step that is not a wait never follows a timeout edge", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), mark("A"), mark("Normal"), mark("Late")],
        [edge("start", "A"), timeoutEdge("A", "Late"), edge("A", "Normal")],
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual(["A", "Normal"]);
  });

  it("Start's fan-out ignores timeout edges", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), mark("A"), mark("Late")],
        [timeoutEdge("start", "Late"), edge("start", "A")],
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual(["A"]);
    expect(h.logs).toContain("[timeout-edges] Executing single branch");
  });

  it("a switch and a choice ignore timeout edges with their handle", async () => {
    for (const decision of [
      node("pick", "switch", { value: 1, cases: [1] }),
      node("pick", "choice", { options: [{ weight: 1 }, { weight: 1e-9 }] }),
    ]) {
      const handle = decision.type === "switch" ? "case-0" : "option-0";
      const h = harness();
      const executor = new ScenarioExecutor(
        scenario(
          [node("start", "start"), decision, mark("Normal"), mark("Late")],
          [
            edge("start", "pick"),
            edge("pick", "Late", { kind: "timeout", sourceHandle: handle }),
            edge("pick", "Normal", { sourceHandle: handle }),
          ],
        ),
        h.callbacks,
      );

      await executor.start();

      expect(h.statuses, decision.type).toEqual(["Normal"]);
    }
  });

  it("operator Continue still goes on along the ordinary edge", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(5), mark("Normal"), mark("Late")],
        [
          edge("start", "wait"),
          edge("wait", "Normal"),
          timeoutEdge("wait", "Late"),
        ],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    executor.continueWait();
    await run;

    expect(h.statuses).toEqual(["Normal"]);
  });

  it("an extended wait times out at its new deadline, then takes the timeout edge", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [node("start", "start"), waitNode(2), mark("Late")],
        [edge("start", "wait"), timeoutEdge("wait", "Late")],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    executor.extendWait(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(h.statuses).toEqual(["Late"]);
  });

  it("a timed-out replace csmsCallTrigger takes no CALL over", async () => {
    const h = harness({
      onWaitForCsmsCall: () => new Promise(() => {}),
    });
    const executor = new ScenarioExecutor(
      scenario(
        [
          node("start", "start"),
          node("call", "csmsCallTrigger", {
            action: "Reset",
            behavior: "replace",
            timeout: 1,
          }),
          node("respond", "callResponse", { kind: "accepted" }),
        ],
        [edge("start", "call"), timeoutEdge("call", "respond")],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    // Along the timeout edge the branch holds no CALL: the callResponse
    // fails the run, as it would right after Start.
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("this branch holds no CALL"),
      }),
    );
  });

  it("a timed-out remoteStartTrigger captures no tag, like Continue", async () => {
    const onStartTransaction = vi.fn(async () => {});
    const h = harness({
      onWaitForRemoteStart: () => new Promise<string>(() => {}),
      onStartTransaction,
    });
    const executor = new ScenarioExecutor(
      scenario(
        [
          node("start", "start"),
          node("remote", "remoteStartTrigger", { timeout: 1 }),
          node("tx", "transaction", { action: "start", tagId: "NODE-TAG" }),
        ],
        [edge("start", "remote"), timeoutEdge("remote", "tx")],
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.onError).not.toHaveBeenCalled();
    // No captured tag, no RemoteStart options: the node's own tag.
    expect(onStartTransaction).toHaveBeenCalledWith(
      "NODE-TAG",
      undefined,
      undefined,
    );
  });
});
