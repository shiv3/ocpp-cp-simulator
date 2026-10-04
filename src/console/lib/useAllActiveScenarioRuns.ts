import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChargePointSnapshot } from "../../data/interfaces/ChargePointService";
import { useDataContext } from "../../data/providers/DataProvider";
import {
  fetchActiveRuns,
  type ActiveScenarioRun,
  type DefinitionCache,
} from "./activeRuns";
import { STATUS_REFRESH_DEBOUNCE_MS } from "./scenarioRunState";

export type ChargePointRun = ActiveScenarioRun & { cpId: string };

export interface UseAllActiveScenarioRunsResult {
  /** Every live run of every charge point, ordered by charge point id. */
  runs: ChargePointRun[];
  /** Re-reads the runs of every charge point now. */
  refresh: () => Promise<void>;
  /** False once the first read of every charge point has answered. */
  isLoading: boolean;
}

/**
 * The live scenario runs of every charge point, for the Scenarios page's
 * Active runs tab. Like `useActiveScenarioRuns`, per charge point: it reads
 * the runs on mount and re-reads (debounced) the charge point whose scenario
 * lifecycle event arrived, so one busy charge point does not re-query the
 * rest. Subscriptions follow the set of charge point ids; a connector added
 * to a charge point re-reads everything.
 */
export function useAllActiveScenarioRuns(
  chargePoints: ChargePointSnapshot[],
): UseAllActiveScenarioRunsResult {
  const { chargePointService } = useDataContext();

  const [runsByCp, setRunsByCp] = useState<Record<string, ActiveScenarioRun[]>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(true);
  const caches = useRef<Map<string, DefinitionCache>>(new Map());
  const isMountedRef = useRef(true);
  // Generation counters: an older, slower answer must not overwrite a newer
  // one. `fullGen` guards whole refreshes, `cpGen` the per-charge-point ones.
  const fullGenRef = useRef(0);
  const cpGenRef = useRef<Map<string, number>>(new Map());

  // Snapshots arrive as a new array on every status change; depend on the
  // content that matters (ids and connector numbers), or each heartbeat would
  // re-read every charge point.
  const layoutKey = JSON.stringify(
    chargePoints
      .map((cp) => [cp.id, cp.connectors.map((c) => c.id)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const layout = useMemo(
    () => new Map(JSON.parse(layoutKey) as Array<[string, number[]]>),
    [layoutKey],
  );
  const idsKey = JSON.stringify([...layout.keys()]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const read = useCallback(
    async (cpIds: string[], full: boolean) => {
      const fullGen = full ? ++fullGenRef.current : fullGenRef.current;
      const gens = new Map<string, number>();
      for (const cpId of cpIds) {
        const gen = (cpGenRef.current.get(cpId) ?? 0) + 1;
        cpGenRef.current.set(cpId, gen);
        gens.set(cpId, gen);
      }

      const answers = await Promise.all(
        cpIds.map(async (cpId) => {
          let cache = caches.current.get(cpId);
          if (!cache) {
            cache = new Map();
            caches.current.set(cpId, cache);
          }
          return [
            cpId,
            await fetchActiveRuns(
              chargePointService,
              cpId,
              layout.get(cpId) ?? [],
              cache,
            ),
          ] as const;
        }),
      );

      // A newer whole refresh supersedes this one entirely.
      if (!isMountedRef.current || fullGen !== fullGenRef.current) return;

      setRunsByCp((previous) => {
        const next: Record<string, ActiveScenarioRun[]> = full
          ? {}
          : { ...previous };
        for (const [cpId, found] of answers) {
          if (cpGenRef.current.get(cpId) === gens.get(cpId)) {
            next[cpId] = found;
          } else if (full) {
            // A newer single-charge-point read owns this one.
            next[cpId] = previous[cpId] ?? found;
          }
        }
        return next;
      });
      if (full) setIsLoading(false);
    },
    [chargePointService, layout],
  );

  const refresh = useCallback(
    () => read([...layout.keys()], true),
    [read, layout],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The subscriptions outlive a `read` change (a connector appearing); they
  // call whichever read is current.
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Debounced like the per-charge-point hook: a burst of node transitions
    // (or a control and its wait-changed echo) is one re-query.
    const schedule = (cpId: string) => {
      pending.add(cpId);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const targets = [...pending];
        pending.clear();
        void readRef.current(targets, false);
      }, STATUS_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribes = ids.map((cpId) =>
      chargePointService.subscribe(cpId, (event) => {
        if (
          event.type === "scenario-started" ||
          event.type === "scenario-node-execute" ||
          event.type === "scenario-completed" ||
          event.type === "scenario-error" ||
          event.type === "scenario-wait-changed"
        ) {
          schedule(cpId);
        }
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [idsKey, chargePointService]);

  const runs = useMemo<ChargePointRun[]>(() => {
    const ids = JSON.parse(idsKey) as string[];
    // Only the charge points still in the list: a removed one drops at once,
    // before any re-read.
    return ids.flatMap((cpId) =>
      (runsByCp[cpId] ?? []).map((run) => ({ ...run, cpId })),
    );
  }, [runsByCp, idsKey]);

  return { runs, refresh, isLoading };
}
