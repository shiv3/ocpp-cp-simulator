import { useCallback, useEffect, useRef, useState } from "react";

import type { TimelinePage } from "../../cp/application/services/OperationalTimeline";
import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";
import { useDataContext } from "../../data/providers/DataProvider";
import { STATUS_REFRESH_DEBOUNCE_MS } from "./scenarioRunState";

const EMPTY_PAGE: TimelinePage = { entries: [], total: 0 };

/** The console events that accompany a timeline entry. Only these trigger a
 *  re-read: the others (log lines, meter samples, scenario node progress)
 *  can arrive faster than the debounce and would keep postponing it. */
const REFRESH_EVENTS: ReadonlySet<ChargePointEvent["type"]> = new Set([
  "connected",
  "disconnected",
  "status",
  "connector-status",
  "connector-transaction",
  "scenario-started",
  "scenario-completed",
  "scenario-error",
  "scenario-wait-changed",
]);

export interface UseOperationalTimelineResult {
  page: TimelinePage;
  isLoading: boolean;
  error: string | null;
  /** False when the service has no timeline method (a test double). Against
   *  a daemon older than #448 the read fails and `error` says so. */
  supported: boolean;
  refresh: () => Promise<void>;
}

/**
 * A charge point's operational timeline (#448, `timeline.get`). Reads on
 * mount and when `cpId` changes, then re-reads (debounced) whenever the
 * charge point reports an event that can add an entry. Some entries — an
 * authorization rejection, a fault injected while the socket stays up — come
 * with no console event; `refresh` re-reads on demand.
 */
export function useOperationalTimeline(
  cpId: string,
): UseOperationalTimelineResult {
  const { chargePointService } = useDataContext();
  const supported =
    typeof chargePointService.getOperationalTimeline === "function";

  const [page, setPage] = useState<TimelinePage>(EMPTY_PAGE);
  const [isLoading, setIsLoading] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  // A slower answer for another charge point (or one landing after unmount)
  // must not overwrite the current one.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!supported) {
      setPage(EMPTY_PAGE);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const result = await chargePointService.getOperationalTimeline!(cpId);
      if (requestId !== requestIdRef.current) return;
      setPage(result);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [chargePointService, cpId, supported]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!supported) return undefined;
    return chargePointService.subscribe(cpId, (event) => {
      if (!REFRESH_EVENTS.has(event.type)) return;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => void refresh(),
        STATUS_REFRESH_DEBOUNCE_MS,
      );
    });
  }, [chargePointService, cpId, refresh, supported]);

  return { page, isLoading, error, supported, refresh };
}
