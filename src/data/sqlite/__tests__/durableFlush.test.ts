import { describe, it, expect } from "vitest";
import { createDurableFlusher } from "../durableFlush";

/**
 * A `save()` whose completion we drive by hand, so tests can deterministically
 * reproduce "a write lands while an earlier save is still in flight".
 */
function controllableSaver() {
  const completed: string[] = []; // snapshots that finished saving, in order
  const queue: Array<{ snapshot: string; resolve: () => void }> = [];
  const save = (snapshot: Uint8Array): Promise<void> =>
    new Promise<void>((resolve) => {
      queue.push({ snapshot: new TextDecoder().decode(snapshot), resolve });
    });
  const inFlight = (): string[] => queue.map((q) => q.snapshot);
  const completeOldest = async (): Promise<void> => {
    const next = queue.shift();
    if (!next) throw new Error("no in-flight save to complete");
    completed.push(next.snapshot);
    next.resolve();
    // Drain all microtasks so chained follow-ups run before we assert.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { save, completed, inFlight, completeOldest };
}

describe("createDurableFlusher", () => {
  it("persists writes made while an earlier save is in flight (#101 regression)", async () => {
    let snapshot = "empty";
    const saver = controllableSaver();
    const flush = createDurableFlusher(
      () => new TextEncoder().encode(snapshot),
      saver.save,
    );

    // Write A, flush -> save of "A" starts and stays in flight.
    snapshot = "A";
    const f1 = flush();
    expect(saver.inFlight()).toEqual(["A"]);

    // Write B arrives WHILE the "A" save is in flight, then flush again.
    snapshot = "B";
    const f2 = flush();

    // Complete the in-flight "A" save; the follow-up must re-export the latest.
    await saver.completeOldest();
    expect(saver.inFlight()).toEqual(["B"]); // <-- old code left this empty
    await saver.completeOldest();

    await Promise.all([f1, f2]);

    // The newest write reached durable storage — it was NOT dropped.
    expect(saver.completed).toEqual(["A", "B"]);
  });

  it("coalesces a burst of flushes during one in-flight save into a single follow-up", async () => {
    let snapshot = "empty";
    const saver = controllableSaver();
    const flush = createDurableFlusher(
      () => new TextEncoder().encode(snapshot),
      saver.save,
    );

    snapshot = "A";
    void flush(); // starts save "A"
    snapshot = "B";
    void flush(); // queues follow-up
    snapshot = "C";
    void flush(); // coalesces onto the same follow-up

    await saver.completeOldest(); // finish "A"
    // Exactly one follow-up, exporting the latest snapshot ("C").
    expect(saver.inFlight()).toEqual(["C"]);
    await saver.completeOldest();
    expect(saver.completed).toEqual(["A", "C"]);
  });

  it("reproduces the OLD bug: return-the-in-flight-promise dropped the write (#101)", async () => {
    // Faithful replica of the previous SqlJsDatabase.flush() coalescing, kept
    // as executable documentation of the regression this module fixes.
    let snapshot = "empty";
    const saver = controllableSaver();
    let pending: Promise<void> | null = null;
    const buggyFlush = (): Promise<void> => {
      if (pending) return pending; // returns a promise whose export predates B
      const dump = new TextEncoder().encode(snapshot);
      pending = saver.save(dump).finally(() => {
        pending = null;
      });
      return pending;
    };

    snapshot = "A";
    const f1 = buggyFlush();
    snapshot = "B";
    const f2 = buggyFlush(); // hands back the "A" save; "B" is never exported

    await saver.completeOldest();
    await Promise.all([f1, f2]);

    expect(saver.completed).toEqual(["A"]);
    expect(saver.completed).not.toContain("B"); // the lost write
  });
});
