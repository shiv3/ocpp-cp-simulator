import { useCallback, useEffect, useRef, useState } from "react";

import {
  TIMELINE_DEFAULT_CAPACITY,
  type TimelineEntry,
  type TimelinePage,
} from "../../cp/application/services/OperationalTimeline";
import { useDataContext } from "../../data/providers/DataProvider";

const EMPTY_PAGE: TimelinePage = { entries: [], total: 0 };

/** The newest entries, at most what the charge point itself keeps. */
function pageOf(entries: TimelineEntry[]): TimelinePage {
  const kept = entries.slice(-TIMELINE_DEFAULT_CAPACITY);
  return { entries: kept, total: kept.length };
}

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
 * A charge point's operational timeline (#448, `timeline.get`). Reads it on
 * mount and when `cpId` changes, then appends each entry the charge point
 * pushes (`timeline-entry`). `seq` increases by one per entry, so a pushed
 * entry that skips one (events missed while the connection was down) makes
 * the hook read the whole timeline again; one it already has is ignored.
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
  // What is on screen, readable synchronously by the push handler.
  const pageRef = useRef<TimelinePage>(EMPTY_PAGE);
  const show = useCallback((next: TimelinePage) => {
    pageRef.current = next;
    setPage(next);
  }, []);
  // A slower answer for another charge point (or one landing after unmount)
  // must not overwrite the current one.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!supported) {
      show(EMPTY_PAGE);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const result = await chargePointService.getOperationalTimeline!(cpId);
      if (requestId !== requestIdRef.current) return;
      // Keep what was pushed while the read was in flight.
      const lastRead = result.entries.at(-1)?.seq ?? 0;
      const pushedSince = pageRef.current.entries.filter(
        (e) => e.cpId === cpId && e.seq > lastRead,
      );
      show(pageOf([...result.entries, ...pushedSince]));
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [chargePointService, cpId, show, supported]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!supported) return undefined;
    return chargePointService.subscribe(cpId, (event) => {
      if (event.type !== "timeline-entry" || event.entry.cpId !== cpId) return;
      const { entry } = event;
      const lastSeq = pageRef.current.entries.at(-1)?.seq;
      if (lastSeq !== undefined && entry.seq <= lastSeq) return;
      if (lastSeq !== undefined && entry.seq !== lastSeq + 1) {
        void refresh();
        return;
      }
      show(pageOf([...pageRef.current.entries, entry]));
    });
  }, [chargePointService, cpId, refresh, show, supported]);

  return { page, isLoading, error, supported, refresh };
}
