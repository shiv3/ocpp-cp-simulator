import { useEffect, useState } from "react";

import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import { useDataContext } from "../providers/DataProvider";

interface UseStateHistoryOptions {
  autoRefresh?: boolean;
  historyOptions?: HistoryOptions;
  intervalMs?: number;
}

interface UseStateHistoryResult {
  history: StateHistoryEntry[];
  isLoading: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

export function useStateHistory(
  chargePointId: string | null,
  {
    autoRefresh = true,
    historyOptions,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
  }: UseStateHistoryOptions = {},
): UseStateHistoryResult {
  const { chargePointService } = useDataContext();
  const [history, setHistory] = useState<StateHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(chargePointId));

  useEffect(() => {
    if (!chargePointId) {
      setHistory([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const fetchHistory = async () => {
      try {
        const entries = await chargePointService.getStateHistory(
          chargePointId,
          historyOptions,
        );
        if (!cancelled) {
          setHistory(entries);
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Failed to fetch state history", err);
        if (!cancelled) setIsLoading(false);
      }
    };

    void fetchHistory();

    let interval: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;

    if (autoRefresh) {
      // Trigger an immediate refetch on relevant push events too — the polling
      // interval is a safety net for cases without push events.
      unsubscribe = chargePointService.subscribe(chargePointId, (event) => {
        if (event.type === "state-history-entry") {
          void fetchHistory();
        }
      });
      interval = setInterval(fetchHistory, intervalMs);
    }

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      unsubscribe?.();
    };
  }, [
    autoRefresh,
    chargePointId,
    historyOptions,
    intervalMs,
    chargePointService,
  ]);

  return { history, isLoading };
}
