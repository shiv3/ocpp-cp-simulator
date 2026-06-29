import { useEffect, useState } from "react";

import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../../cp/application/services/types/StateSnapshot";
import { useDataContext } from "../providers/DataProvider";
import type { RemoteConnectionState } from "../remote/RemoteChargePointService";

interface UseStateHistoryOptions {
  autoRefresh?: boolean;
  historyOptions?: HistoryOptions;
  intervalMs?: number;
}

interface UseStateHistoryResult {
  history: StateHistoryEntry[];
  isLoading: boolean;
}

interface ConnectionAwareService {
  onConnectionChange(
    handler: (state: RemoteConnectionState) => void,
  ): () => void;
}

function isConnectionAwareService(
  service: unknown,
): service is ConnectionAwareService {
  return (
    typeof service === "object" &&
    service !== null &&
    "onConnectionChange" in service &&
    typeof (service as { onConnectionChange?: unknown }).onConnectionChange ===
      "function"
  );
}

export function useStateHistory(
  chargePointId: string | null,
  { autoRefresh = true, historyOptions }: UseStateHistoryOptions = {},
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

    let unsubscribe: (() => void) | null = null;
    let unsubscribeConnection: (() => void) | null = null;

    if (autoRefresh) {
      unsubscribe = chargePointService.subscribe(chargePointId, (event) => {
        if (event.type === "state-history-entry") {
          void fetchHistory();
        }
      });
      if (isConnectionAwareService(chargePointService)) {
        let sawInitialConnectionState = false;
        unsubscribeConnection = chargePointService.onConnectionChange(
          (state) => {
            if (!sawInitialConnectionState) {
              sawInitialConnectionState = true;
              return;
            }
            if (state === "connected") void fetchHistory();
          },
        );
      }
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeConnection?.();
    };
  }, [autoRefresh, chargePointId, historyOptions, chargePointService]);

  return { history, isLoading };
}
