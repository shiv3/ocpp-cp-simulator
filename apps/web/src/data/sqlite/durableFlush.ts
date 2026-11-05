/**
 * Write-back coalescer for a single durable snapshot — used to persist the
 * sql.js in-memory database to IndexedDB (see {@link ./SqlJsDatabase}).
 *
 * Guarantee: every write made *before* a `flush()` call is included in some
 * completed `save`, even writes made while an earlier save is still in flight.
 *
 * The previous "return the in-flight promise" approach silently dropped those
 * writes (#101): the in-flight save had already captured its snapshot before
 * the new write, and the explicit flush both cancelled the pending debounce and
 * returned that stale promise — so `await flush()` resolved while the newest
 * data never reached storage. On the next page load the pre-write blob was
 * restored, so an uploaded/saved scenario appeared to "not save" after refresh.
 *
 * Here, a flush that arrives while a save is in flight queues exactly one
 * follow-up that re-exports the latest snapshot once the in-flight save settles.
 * Concurrent callers coalesce onto that single follow-up, so a burst of writes
 * costs at most one extra save rather than one per write.
 */
export function createDurableFlusher(
  exportSnapshot: () => Uint8Array,
  save: (snapshot: Uint8Array) => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const startSave = (): Promise<void> => {
    const snapshot = exportSnapshot();
    const p = save(snapshot).finally(() => {
      if (pending === p) pending = null;
    });
    pending = p;
    return p;
  };

  return function flush(): Promise<void> {
    if (!pending) return startSave();
    // A save is mid-flight with a snapshot that may predate recent writes.
    // Queue one follow-up that re-exports after it settles; coalesce callers.
    queued ??= pending
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return startSave();
      });
    return queued;
  };
}
