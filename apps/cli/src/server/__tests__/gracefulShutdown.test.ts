import { afterEach, describe, expect, it, vi } from "vitest";
import { stopTransactionsAndWait } from "../gracefulShutdown";
import { createLifecycle } from "../lifecycle";
import type { CPRegistry } from "../CPRegistry";

type FrameHandler = (direction: "Sent" | "Received", raw: string) => void;

function fakeService(opts: {
  online?: boolean;
  soap?: boolean;
  connectors?: number[];
  /** Read on every pass, so a test can open a transaction mid-wait. */
  live?: () => number[];
}) {
  let handler: FrameHandler | null = null;
  const stopped: number[] = [];
  const options: unknown[] = [];
  const queued = { count: 0 };
  const svc = {
    isOnline: () => opts.online ?? true,
    isSoapChargePoint: () => opts.soap ?? false,
    queueUnansweredStop: () => {
      queued.count++;
      return true;
    },
    openTransactionConnectorIds: () => opts.live?.() ?? opts.connectors ?? [1],
    onWireFrame: (h: FrameHandler) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    stopTransaction: (id: number, o?: unknown) => {
      stopped.push(id);
      options.push(o);
    },
  };
  return {
    svc,
    stopped,
    options,
    queued,
    emit: (d: "Sent" | "Received", raw: string) => handler?.(d, raw),
    subscribed: () => handler !== null,
  };
}

const registryOf = (map: Record<string, ReturnType<typeof fakeService>>) =>
  ({
    list: () => Object.keys(map),
    get: (id: string) => map[id]?.svc,
  }) as unknown as Pick<CPRegistry, "list" | "get">;

describe("stopTransactionsAndWait", () => {
  it("returns at once when nothing is running", async () => {
    const cp = fakeService({ connectors: [] });
    const report = await stopTransactionsAndWait(registryOf({ A: cp }), 1000);
    expect(report).toEqual({ stopped: 0, delivered: 0, timedOut: false });
  });

  it("waits for the CALLRESULT of each StopTransaction, then returns", async () => {
    const cp = fakeService({ connectors: [1] });
    const lines: string[] = [];
    const done = stopTransactionsAndWait(registryOf({ A: cp }), 5000, (l) =>
      lines.push(l),
    );
    expect(cp.stopped).toEqual([1]);
    cp.emit("Sent", '[2,"m1","StopTransaction",{"transactionId":7}]');
    cp.emit("Received", '[3,"m1",{}]');
    await expect(done).resolves.toEqual({
      stopped: 1,
      delivered: 1,
      timedOut: false,
    });
    expect(cp.subscribed()).toBe(false);
  });

  it("counts a 2.x TransactionEvent(Ended) and ignores other calls", async () => {
    const cp = fakeService({ connectors: [1] });
    const done = stopTransactionsAndWait(registryOf({ A: cp }), 5000);
    cp.emit("Sent", '[2,"u1","TransactionEvent",{"eventType":"Updated"}]');
    cp.emit("Received", '[3,"u1",{}]');
    cp.emit("Sent", '[2,"e1","TransactionEvent",{"eventType":"Ended"}]');
    cp.emit("Received", '[4,"e1","InternalError","",{}]');
    await expect(done).resolves.toMatchObject({ delivered: 1 });
  });

  it("gives up at the time limit when the CSMS never answers", async () => {
    const cp = fakeService({ connectors: [1] });
    const report = await stopTransactionsAndWait(registryOf({ A: cp }), 150);
    expect(report).toEqual({ stopped: 1, delivered: 0, timedOut: true });
    expect(cp.queued.count).toBe(1); // the unanswered stop is not lost
  });

  it("does not wait for a charge point that is offline", async () => {
    const cp = fakeService({ connectors: [1, 2], online: false });
    const started = Date.now();
    const report = await stopTransactionsAndWait(registryOf({ A: cp }), 5000);
    expect(report).toMatchObject({ stopped: 2, timedOut: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("names a reason that is not a driver's authorization on 2.x", async () => {
    const cp = fakeService({ connectors: [1], online: false });
    await stopTransactionsAndWait(registryOf({ A: cp }), 0);
    expect(cp.options).toEqual([
      { reason: "Other", triggerReason: "AbnormalCondition" },
    ]);
  });

  it("does not wait for a SOAP charge point", async () => {
    const cp = fakeService({ connectors: [1], soap: true });
    const started = Date.now();
    const report = await stopTransactionsAndWait(registryOf({ A: cp }), 5000);
    expect(report).toMatchObject({ stopped: 1, timedOut: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops a transaction opened while it waits", async () => {
    let open = [1];
    const cp = fakeService({ live: () => open });
    const done = stopTransactionsAndWait(registryOf({ A: cp }), 5000);
    cp.emit("Sent", '[2,"s1","StopTransaction",{"transactionId":1}]');
    open = []; // the first stop closed connector 1 ...
    await new Promise((r) => setTimeout(r, 20));
    open = [2]; // ... and a command opens connector 2 before s1 is answered
    await vi.waitFor(() => expect(cp.stopped).toEqual([1, 2]));
    cp.emit("Received", '[3,"s1",{}]');
    cp.emit("Sent", '[2,"s2","StopTransaction",{"transactionId":2}]');
    cp.emit("Received", '[3,"s2",{}]');
    await expect(done).resolves.toMatchObject({ stopped: 2, delivered: 2 });
  });

  it("stops waiting when told to skip", async () => {
    const cp = fakeService({ connectors: [1] });
    let skip!: () => void;
    const skipped = new Promise<void>((resolve) => (skip = resolve));
    const done = stopTransactionsAndWait(
      registryOf({ A: cp }),
      60_000,
      undefined,
      skipped,
    );
    skip();
    await expect(done).resolves.toMatchObject({ stopped: 1, delivered: 0 });
  });
});

describe("createLifecycle beforeShutdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs before the teardown and a second request skips the wait", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const order: string[] = [];
    let release!: () => void;
    const lifecycle = createLifecycle({
      pidPath: null,
      registry: {
        shutdownAll: () => order.push("registry"),
      } as unknown as CPRegistry,
      onShutdownStart: () => order.push("teardown"),
      beforeShutdown: async (skip) => {
        order.push("before");
        await Promise.race([
          skip,
          new Promise<void>((resolve) => (release = resolve)),
        ]);
        order.push("after");
      },
    });
    lifecycle.requestShutdown();
    expect(order).toEqual(["before"]);
    expect(exit).not.toHaveBeenCalled();
    lifecycle.requestShutdown(); // second signal
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["before", "after", "teardown", "registry"]);
    release?.();
  });

  it("still tears down when the graceful step throws", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lifecycle = createLifecycle({
      pidPath: null,
      registry: { shutdownAll: vi.fn() } as unknown as CPRegistry,
      beforeShutdown: () => Promise.reject(new Error("boom")),
    });
    lifecycle.requestShutdown(3);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
  });
});
