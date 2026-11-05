import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDataContext } from "../../data/providers/DataProvider";
import {
  fetchActiveRuns,
  type ActiveScenarioRun,
  type DefinitionCache,
} from "./activeRuns";
import { STATUS_REFRESH_DEBOUNCE_MS } from "./scenarioRunState";

export type { ActiveScenarioRun } from "./activeRuns";

/**
 * Tracks the scenario runs currently executing (or parked waiting) on a
 * charge point's connectors (#240). Queries listScenarios/getScenarioStatus
 * on mount and re-queries (debounced) whenever a scenario lifecycle event
 * arrives on the CP's event stream; live countdowns are the consumer's job
 * (compute from `waitDeadlineAt`, see remainingWaitMs).
 */
export function useActiveScenarioRuns(
  cpId: string | null,
  connectorIds: number[],
): {
  runs: ActiveScenarioRun[];
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
} {
  const { chargePointService } = useDataContext();

  const [runs, setRuns] = useState<ActiveScenarioRun[]>([]);
  const definitionCacheRef = useRef<DefinitionCache>(new Map());
  const isMountedRef = useRef(true);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter: an older, slower refresh must not overwrite the
  // results of a newer one that resolved first.
  const requestIdRef = useRef(0);

  // Callers typically pass a freshly-mapped array each render; depend on its
  // content, not its identity, or every render would recreate refresh() and
  // re-trigger the fetch effect in a loop.
  const connectorIdsKey = connectorIds.join(",");
  const ids = useMemo(
    () =>
      connectorIdsKey === ""
        ? []
        : connectorIdsKey.split(",").map((id) => Number(id)),
    [connectorIdsKey],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!cpId) return;
    const requestId = ++requestIdRef.current;
    const found = await fetchActiveRuns(
      chargePointService,
      cpId,
      ids,
      definitionCacheRef.current,
    );

    if (isMountedRef.current && requestId === requestIdRef.current) {
      setRuns(found);
    }
  }, [cpId, ids, chargePointService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Debounced refresh: collapses a burst of triggers (node transitions, a
   *  control and its own `scenario-wait-changed` echo) into one re-query. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    refreshTimeoutRef.current = setTimeout(() => {
      void refresh();
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    if (!cpId) return undefined;

    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if (
        event.type === "scenario-started" ||
        event.type === "scenario-node-execute" ||
        event.type === "scenario-completed" ||
        event.type === "scenario-error" ||
        event.type === "scenario-wait-changed"
      ) {
        scheduleRefresh();
      }
    });

    return () => {
      unsubscribe();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [cpId, chargePointService, scheduleRefresh]);

  return { runs, refresh, scheduleRefresh };
}
