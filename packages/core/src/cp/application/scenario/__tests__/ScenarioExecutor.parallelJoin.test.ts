/**
 * Schema 1.9: a `parallel` node runs every outgoing ordinary edge as its own
 * branch and waits until they meet at a `join`; `all` goes on once every
 * branch arrived or ended, `any` at the first arrival, cancelling the rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { cancellablePromise } from "../cancellable";
import type {
  ScenarioCallExchange,
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

const mark = (id: string) => node(id, "statusChange", { status: id });
const delay = (id: string, seconds: number) =>
  node(id, "delay", { delaySeconds: seconds });
const parallel = (id = "P") => node(id, "parallel");
const join = (id = "J", mode?: "all" | "any") =>
  node(id, "join", mode ? { mode } : {});
const waitForever = (id: string) =>
  node(id, "statusTrigger", { targetStatus: "Charging" });

/** Edges `a>b` from "a>b" strings. */
const edges = (...pairs: string[]): ScenarioEdge[] =>
  pairs.map((pair) => {
    const [source, target] = pair.split(">");
    return { id: pair, source: source!, target: target! };
  });

const scenario = (
  nodes: ScenarioNode[],
  edgeList: ScenarioEdge[],
): ScenarioDefinition => ({
  id: "parallel-join",
  name: "parallel-join",
  targetType: "connector",
  targetId: 1,
  nodes: [node("start", "start"), ...nodes],
  edges: edgeList,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function harness(extra: Partial<ScenarioExecutorCallbacks> = {}) {
  const statuses: string[] = [];
  const logs: string[] = [];
  const statusWaits: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
  const onError = vi.fn();
  const callbacks: ScenarioExecutorCallbacks = {
    onWaitForStatus: () => {
      const cancel = vi.fn();
      statusWaits.push({ cancel });
      return cancellablePromise({
        promise: new Promise<void>(() => {}),
        cancel,
      });
    },
    onStatusChange: async (status) => {
      statuses.push(status);
    },
    log: (message) => {
      logs.push(message);
    },
    onError,
    ...extra,
  };
  return { statuses, logs, statusWaits, onError, callbacks };
}

const exchange = (): ScenarioCallExchange & {
  answer: ReturnType<typeof vi.fn>;
} => ({
  action: "Reset",
  messageId: "m1",
  payload: { type: "Soft" },
  answer: vi.fn(() => Promise.resolve({ delivered: true as const })),
});

describe("parallel and join (schema 1.9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an all-join waits for every branch, then goes on once", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), delay("A", 1), delay("B", 3), join(), mark("After")],
        edges("start>P", "P>A", "P>B", "A>J", "B>J", "J>After"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["After"]);
    const executed = executor.getContext().executedNodes;
    expect(executed.filter((id) => id === "J")).toEqual(["J"]);
    expect(executed.at(-1)).toBe("After");
    expect(executor.getContext().state).toBe("completed");
  });

  it("an all-join goes on after a branch that ended without arriving", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel(),
          delay("A", 1),
          delay("B", 2),
          node("end", "end"),
          join(),
          mark("After"),
        ],
        edges("start>P", "P>A", "P>B", "A>J", "B>end", "J>After"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.statuses).toEqual(["After"]);
  });

  it("when no branch reaches a join, nothing goes on", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), mark("A"), mark("B")],
        edges("start>P", "P>A", "P>B"),
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses.sort()).toEqual(["A", "B"]);
    expect(executor.getContext().state).toBe("completed");
    expect(h.logs).toContain(
      '[parallel-join] No branch of "P" reached a join; the branch ends',
    );
  });

  it("an any-join goes on at the first arrival and cancels a parked wait and a delay", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel(),
          delay("A", 1),
          waitForever("B"),
          mark("AfterB"),
          delay("C", 60),
          mark("AfterC"),
          join("J", "any"),
          mark("After"),
        ],
        edges(
          "start>P",
          "P>A",
          "P>B",
          "P>C",
          "A>J",
          "B>AfterB",
          "AfterB>J",
          "C>AfterC",
          "AfterC>J",
          "J>After",
        ),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.getContext().state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    // The run is over without the 60 s delay: it kept nothing alive.
    await run;

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["After"]);
    expect(h.statusWaits).toHaveLength(1);
    expect(h.statusWaits[0]!.cancel).toHaveBeenCalled();
    expect(executor.getContext().executedNodes).not.toContain("AfterB");
    expect(executor.getContext().executedNodes).not.toContain("AfterC");
    expect(
      h.logs.filter((line) => line.includes("cancelled: another branch")),
    ).toHaveLength(2);

    // Nothing of the cancelled branches runs later.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.statuses).toEqual(["After"]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("a cancelled branch answers its open replace CALL InternalError at once", async () => {
    const call = exchange();
    const h = harness({
      onWaitForCsmsCall: () =>
        Promise.resolve({ action: "Reset", payload: {}, exchange: call }),
    });
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel(),
          delay("A", 1),
          node("T", "csmsCallTrigger", {
            action: "Reset",
            behavior: "replace",
          }),
          waitForever("W"),
          join("J", "any"),
        ],
        edges("start>P", "P>A", "P>T", "A>J", "T>W", "W>J"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(call.answer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(call.answer).toHaveBeenCalledTimes(1);
    expect(call.answer).toHaveBeenCalledWith({
      kind: "error",
      errorCode: "InternalError",
      errorDescription:
        "The scenario cancelled the branch before it answered this call",
    });
  });

  it("a branch that reaches a join with an open CALL answers it InternalError there", async () => {
    const call = exchange();
    const h = harness({
      onWaitForCsmsCall: () =>
        Promise.resolve({ action: "Reset", payload: {}, exchange: call }),
    });
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel(),
          node("T", "csmsCallTrigger", {
            action: "Reset",
            behavior: "replace",
          }),
          join(),
          mark("After"),
        ],
        edges("start>P", "P>T", "T>J", "J>After"),
      ),
      h.callbacks,
    );

    await executor.start();

    expect(call.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        errorCode: "InternalError",
        errorDescription:
          "The scenario reached a join before it answered this call",
      }),
    );
    expect(h.statuses).toEqual(["After"]);
  });

  it("nested parallel / join: the inner join goes on in its outer branch", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel("P1"),
          parallel("P2"),
          delay("a", 1),
          delay("b", 2),
          join("J2"),
          mark("Inner"),
          delay("c", 1),
          join("J1"),
          mark("After"),
        ],
        edges(
          "start>P1",
          "P1>P2",
          "P1>c",
          "P2>a",
          "P2>b",
          "a>J2",
          "b>J2",
          "J2>Inner",
          "Inner>J1",
          "c>J1",
          "J1>After",
        ),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.statuses).toEqual(["Inner", "After"]);
    const executed = executor.getContext().executedNodes;
    expect(executed.filter((id) => id === "J1")).toHaveLength(1);
    expect(executed.filter((id) => id === "J2")).toHaveLength(1);
  });

  it("an outer any-join cancels the branches of an inner parallel too", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel("P1"),
          parallel("P2"),
          waitForever("w1"),
          delay("d2", 30),
          join("J2"),
          mark("Inner"),
          delay("fast", 1),
          join("J1", "any"),
          mark("After"),
        ],
        edges(
          "start>P1",
          "P1>P2",
          "P1>fast",
          "P2>w1",
          "P2>d2",
          "w1>J2",
          "d2>J2",
          "J2>Inner",
          "Inner>J1",
          "fast>J1",
          "J1>After",
        ),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.statuses).toEqual(["After"]);
    expect(h.statusWaits[0]!.cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.statuses).toEqual(["After"]);
  });

  it("stop() during a parallel region stops every branch", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), delay("A", 10), waitForever("B"), join(), mark("After")],
        edges("start>P", "P>A", "P>B", "A>J", "B>J", "J>After"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    executor.stop();
    await run;

    expect(executor.getContext().state).toBe("idle");
    expect(h.statusWaits[0]!.cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.statuses).toEqual([]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("a failing branch fails the run and cancels its siblings", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [
          parallel(),
          delay("A", 1),
          node("R", "callResponse", { kind: "accepted" }),
          waitForever("B"),
          mark("AfterB"),
          join(),
        ],
        edges("start>P", "P>A", "A>R", "R>J", "P>B", "B>AfterB", "AfterB>J"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("this branch holds no CALL"),
      }),
    );
    expect(executor.getContext().state).toBe("error");
    expect(h.statusWaits[0]!.cancel).toHaveBeenCalled();
    expect(h.statuses).toEqual([]);
  });

  it("a join no parallel started is a plain step", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [mark("A"), join("J", "any"), mark("After")],
        edges("start>A", "A>J", "J>After"),
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual(["A", "After"]);
    expect(h.logs).toContain(
      '[parallel-join] Join "J" reached by a branch no parallel started; it runs as a plain step',
    );
  });

  it("resuming inside a branch runs that branch alone; its join is a plain step", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), mark("A"), delay("B", 30), join(), mark("After")],
        edges("start>P", "P>A", "P>B", "A>J", "B>J", "J>After"),
      ),
      h.callbacks,
    );

    await executor.start({ resumeFromNodeId: "A" });

    expect(h.statuses).toEqual(["After"]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("resuming from a parallel runs it again: its branches meet at the join", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), mark("A"), mark("B"), join(), mark("After")],
        edges("start>P", "P>A", "P>B", "A>J", "B>J", "J>After"),
      ),
      h.callbacks,
    );

    await executor.start({ resumeFromNodeId: "P" });

    expect(h.statuses.sort()).toEqual(["A", "After", "B"]);
    expect(
      executor.getContext().executedNodes.filter((id) => id === "After"),
    ).toHaveLength(1);
  });
  // Tolerant reading: a file is never refused for what it says here.
  it("an unknown join mode means all", async () => {
    const h = harness();
    const bogus = node("J", "join", { mode: "bogus" });
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), delay("A", 1), delay("B", 3), bogus, mark("After")],
        edges("start>P", "P>A", "P>B", "A>J", "B>J", "J>After"),
      ),
      h.callbacks,
    );

    const run = executor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["After"]);
  });

  it("a parallel with no usable edge just ends its branch", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), mark("After")],
        [...edges("start>P"), { id: "P>gone", source: "P", target: "gone" }],
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).toEqual([]);
    expect(executor.getContext().state).toBe("completed");
  });

  it("a parallel with one branch behaves as a plain step into the join", async () => {
    const h = harness();
    const executor = new ScenarioExecutor(
      scenario(
        [parallel(), mark("A"), join(), mark("After")],
        edges("start>P", "P>A", "A>J", "J>After"),
      ),
      h.callbacks,
    );

    await executor.start();

    expect(h.statuses).toEqual(["A", "After"]);
  });
});
