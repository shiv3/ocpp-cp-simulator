import { useEffect, useState } from "react";

import type { HistoryOptions, StateHistoryEntry } from "../../cp/application/services/types/StateSnapshot";
import { useDataContext } from "../providers/DataProvider";

interface UseStateHistoryOptions {
  autoRefresh?: boolean;
  historyOptions?: HistoryOptions;
}

interface UseStateHistoryResult {
  history: StateHistoryEntry[];
  isLoading: boolean;
}

export function useStateHistory(
  chargePointId: string | null,
  { autoRefresh = true, historyOptions }: UseStateHistoryOptions = {},
): UseStateHistoryResult {
  const { stateHistoryProvider } = useDataContext();
  const [history, setHistory] = useState<StateHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(chargePointId));

  useEffect(() => {
    if (!chargePointId) {
      setHistory([]);
      setIsLoading(false);
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    stateHistoryProvider
      .getHistory(chargePointId, historyOptions)
      .then((entries) => {
        if (!cancelled) {
          setHistory(entries);
          setIsLoading(false);
        }
      })
      .catch((error) => {
        console.error("Failed to fetch state history", error);
        setIsLoading(false);
      });

    if (autoRefresh) {
      unsubscribe = stateHistoryProvider.subscribe(chargePointId, setHistory, historyOptions);
    }

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [autoRefresh, chargePointId, historyOptions, stateHistoryProvider]);

  return { history, isLoading };
}
