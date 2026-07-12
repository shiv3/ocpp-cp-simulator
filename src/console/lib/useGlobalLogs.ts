import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LogEntry } from "../../cp/shared/Logger";
import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { useDataContext } from "../../data/providers/DataProvider";

/** One aggregated log line: which CP it came from, the raw entry, and a
 *  monotonic append-order counter used as a stable React key (timestamps
 *  alone can collide when several entries land in the same millisecond). */
export interface GlobalLogEntry {
  cpId: string;
  entry: LogEntry;
  seq: number;
}

export interface UseGlobalLogsOptions {
  /** Ring buffer capacity — oldest entries are dropped once exceeded.
   *  Defaults to 2000. */
  max?: number;
}

export interface UseGlobalLogsResult {
  /** Newest first. */
  entries: GlobalLogEntry[];
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clear: () => void;
}

const DEFAULT_MAX = 2000;

/** HH:mm:ss in local time — shared by LogsPage's row list and the
 *  Dashboard's "Recent activity" strip so both render timestamps the same
 *  way. Deliberately hand-rolled instead of `toLocaleTimeString` so output
 *  doesn't depend on the runtime's ICU/locale data (dom tests included). */
export function formatLogTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Returns an array with the same *contents* as `ids` (deduped, sorted) but a
 * stable reference across renders where the content hasn't changed.
 * `useChargePoints` hands back a brand-new array on every registry/local
 * sync even when the set of ids didn't change, and the subscribe effect
 * below must not tear down/re-establish every per-CP subscription on each
 * of those no-op renders.
 */
function useStableSortedIds(ids: string[]): string[] {
  const sorted = useMemo(() => Array.from(new Set(ids)).sort(), [ids]);
  const ref = useRef<string[]>([]);
  const unchanged =
    ref.current.length === sorted.length &&
    ref.current.every((id, i) => id === sorted[i]);
  if (!unchanged) {
    ref.current = sorted;
  }
  return ref.current;
}

/**
 * Aggregates `{type: "log"}` events across every registered charge point
 * into a single ring buffer (Task 9). There is no cross-CP log stream on
 * `ChargePointService` — each CP's Logger is independent and only reachable
 * via `chargePointService.subscribe(cpId, handler)` — so this walks the ids
 * `useChargePoints` returns and subscribes to each individually, tagging
 * every entry with the cpId it came from.
 *
 * `paused` is read through a ref inside the per-CP event handlers rather
 * than being an effect dependency: toggling Pause/Resume must not tear down
 * and re-establish every subscription (which would risk missing an event
 * delivered mid-toggle) — it only flips whether an incoming event is kept.
 */
export function useGlobalLogs(
  opts?: UseGlobalLogsOptions,
): UseGlobalLogsResult {
  const max = opts?.max ?? DEFAULT_MAX;
  const { chargePointService } = useDataContext();
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });

  const [entries, setEntries] = useState<GlobalLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const seqRef = useRef(0);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const rawIds = useMemo(() => chargePoints.map((cp) => cp.id), [chargePoints]);
  const cpIds = useStableSortedIds(rawIds);

  useEffect(() => {
    const unsubscribes = cpIds.map((cpId) =>
      chargePointService.subscribe(cpId, (event: ChargePointEvent) => {
        if (event.type !== "log") return;
        if (pausedRef.current) return;
        const seq = seqRef.current++;
        setEntries((prev) => {
          const next = [{ cpId, entry: event.entry, seq }, ...prev];
          return next.length > max ? next.slice(0, max) : next;
        });
      }),
    );
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [cpIds, chargePointService, max]);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  return { entries, paused, setPaused, clear };
}
