import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { useDataContext } from "../../data/providers/DataProvider";
import {
  GlobalLogsContext,
  type GlobalLogEntry,
  type UseGlobalLogsResult,
} from "./globalLogsContext";

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

const DEFAULT_MAX = 2000;

export interface GlobalLogsProviderProps {
  children: React.ReactNode;
  /** Ring buffer capacity — oldest entries are dropped once exceeded.
   *  Defaults to 2000. */
  max?: number;
}

/**
 * Owns the single, app-wide log ring buffer (Task 9) and every per-CP
 * subscription that feeds it. Mounted once in `AppShell`, above `<Outlet/>`,
 * so it stays alive across every console route change — `DashboardPage` and
 * `LogsPage` (and anything else) read the *same* accumulated entries via
 * `useGlobalLogs()` instead of each starting a fresh, component-local
 * buffer that resets on navigation.
 *
 * There is no cross-CP log stream on `ChargePointService` — each CP's
 * Logger is independent and only reachable via
 * `chargePointService.subscribe(cpId, handler)` — so this walks the ids
 * `useChargePoints` returns and subscribes to each individually, tagging
 * every entry with the cpId it came from.
 *
 * `paused` is read through a ref inside the per-CP event handlers rather
 * than being an effect dependency: toggling Pause/Resume must not tear down
 * and re-establish every subscription (which would risk missing an event
 * delivered mid-toggle) — it only flips whether an incoming event is kept.
 */
export const GlobalLogsProvider: React.FC<GlobalLogsProviderProps> = ({
  children,
  max = DEFAULT_MAX,
}) => {
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

  const value = useMemo<UseGlobalLogsResult>(
    () => ({ entries, paused, setPaused, clear }),
    [entries, paused, setPaused, clear],
  );

  return (
    <GlobalLogsContext.Provider value={value}>
      {children}
    </GlobalLogsContext.Provider>
  );
};
