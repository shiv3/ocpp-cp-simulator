/**
 * Windowing for `logs.get`.
 *
 * `listStoredLogs` returns a charge point's whole log buffer in chronological
 * order (`ORDER BY id ASC`). `logs.get` used to answer a `limit` with
 * `entries.slice(0, limit)` — the OLDEST N. On a charge point that has been up
 * for days no `limit` could reach recent activity, which made the parameter
 * useless for the thing operators actually ask ("what just happened?").
 *
 * `limit` now selects the newest N and `offset` pages backwards from the newest,
 * so walking history is `{limit: 100, offset: 0}`, then `{limit: 100, offset:
 * 100}`, and so on. Entries come back oldest-first by default (`order: "asc"`),
 * which keeps a window readable top-to-bottom; `"desc"` reverses it for clients
 * that render newest-first.
 */
export type LogOrder = "asc" | "desc";

export interface LogWindowOptions {
  /** How many entries to return. Omitted = every entry left after `offset`. */
  readonly limit?: number;
  /** How many of the newest entries to skip before taking `limit`. */
  readonly offset?: number;
  /** Order of the returned window. Default `"asc"` (oldest first). */
  readonly order?: LogOrder;
}

/**
 * Select a window from `entries`, which MUST be in chronological order
 * (oldest first).
 */
export function selectLogWindow<T>(
  entries: ReadonlyArray<T>,
  options: LogWindowOptions = {},
): T[] {
  const { limit, offset, order } = options;

  // Drop the newest `offset` entries; everything older stays a candidate.
  const skipNewest =
    typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0;
  const end = Math.max(0, entries.length - skipNewest);
  const candidates = entries.slice(0, end);

  // Then take the newest `limit` of what's left -- the tail, not the head.
  const window =
    typeof limit === "number" && limit >= 0
      ? candidates.slice(Math.max(0, candidates.length - Math.floor(limit)))
      : candidates.slice();

  return order === "desc" ? window.reverse() : window;
}
