import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ScenarioRunPage,
  ScenarioRunQuery,
} from "../../cp/application/verification/ScenarioRunSummary";
import { canSubscribeRegistry } from "../../data/hooks/useChargePoints";
import { useDataContext } from "../../data/providers/DataProvider";
import { STATUS_REFRESH_DEBOUNCE_MS } from "./scenarioRunState";

const EMPTY_PAGE: ScenarioRunPage = { runs: [], total: 0 };

export interface UseScenarioRunHistoryResult {
  page: ScenarioRunPage;
  isLoading: boolean;
  error: string | null;
  /** False in local mode: the browser runtime records no run history. */
  supported: boolean;
  refresh: () => Promise<void>;
}

/** Whether a run recorded on `cpId` for this connector / scenario can be in
 *  the listing `query` asks for (the event carries no verdict to check). */
function mayMatch(
  query: ScenarioRunQuery | null,
  cpId: string,
  run: { connectorId: number; scenarioId: string },
): boolean {
  return (
    !query ||
    ((query.cpId === undefined || query.cpId === cpId) &&
      (query.connectorId === undefined ||
        query.connectorId === run.connectorId) &&
      (query.scenarioId === undefined || query.scenarioId === run.scenarioId))
  );
}

/**
 * The daemon's recorded scenario runs matching `query` (#388,
 * `scenario.runs.list`). Lists on mount and whenever the query changes, and
 * re-lists (debounced) when one of `watchCpIds` records a run the query can
 * match — the `scenario-run-recorded` event fires after the write, so the
 * re-list sees it — and when the registry reports a charge point deleted or
 * the simulator reset, which drop runs. `query = null` lists nothing (the
 * caller's target is not known yet).
 *
 * The history lives in the daemon, not in this hook, so it survives
 * navigating away and back.
 */
export function useScenarioRunHistory(
  query: ScenarioRunQuery | null,
  watchCpIds: string[],
): UseScenarioRunHistoryResult {
  const { chargePointService, mode } = useDataContext();
  const supported =
    mode === "remote" &&
    typeof chargePointService.listScenarioRuns === "function";

  const [page, setPage] = useState<ScenarioRunPage>(EMPTY_PAGE);
  const [refreshing, setRefreshing] = useState(false);
  // The query `page` answers. Until the current query has been answered the
  // hook is loading — from the very first render, and again from the render
  // a query change lands in, before the effect that asks runs — so a caller
  // never reads a stale `page` (another query's `total`) as this query's.
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Generation counter: a slower answer to an older query (or one landing
  // after unmount) must not overwrite the current one.
  const requestIdRef = useRef(0);

  // Callers build the query and the watch list inline; depend on their
  // content, not their identity, or every render would re-list.
  const queryKey = JSON.stringify(query);
  const stableQuery = useMemo(
    () => JSON.parse(queryKey) as ScenarioRunQuery | null,
    [queryKey],
  );
  const watchKey = watchCpIds.join("\n");
  const isLoading =
    refreshing ||
    (supported && stableQuery !== null && answeredKey !== queryKey);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!supported || stableQuery === null) {
      setPage(EMPTY_PAGE);
      setError(null);
      setAnsweredKey(queryKey);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const result = await chargePointService.listScenarioRuns!(stableQuery);
      if (requestId !== requestIdRef.current) return;
      setPage(result ?? EMPTY_PAGE);
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setAnsweredKey(queryKey);
        setRefreshing(false);
      }
    }
  }, [chargePointService, queryKey, stableQuery, supported]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  // Read through refs, so a new query does not tear the subscriptions down:
  // each one is an `events.subscribe` round trip per charge point.
  const refreshRef = useRef(refresh);
  const queryRef = useRef(stableQuery);
  useEffect(() => {
    refreshRef.current = refresh;
    queryRef.current = stableQuery;
  }, [refresh, stableQuery]);

  /** Debounced re-list: collapses a burst of triggers into one query. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => void refreshRef.current(),
      STATUS_REFRESH_DEBOUNCE_MS,
    );
  }, []);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!supported || watchKey === "") return undefined;
    const unsubscribes = watchKey.split("\n").map((cpId) =>
      chargePointService.subscribe(cpId, (event) => {
        if (
          event.type === "scenario-run-recorded" &&
          mayMatch(queryRef.current, cpId, event)
        ) {
          scheduleRefresh();
        }
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [chargePointService, scheduleRefresh, supported, watchKey]);

  // Deleting a charge point or resetting the simulator drops runs without
  // recording one; the registry stream is what announces it.
  useEffect(() => {
    if (!supported || !canSubscribeRegistry(chargePointService)) {
      return undefined;
    }
    return chargePointService.subscribeRegistry((event) => {
      if (
        event.type === "change" &&
        (event.change === "removed" || event.change === "reset")
      ) {
        scheduleRefresh();
      }
    });
  }, [chargePointService, scheduleRefresh, supported]);

  return { page, isLoading, error, supported, refresh };
}
