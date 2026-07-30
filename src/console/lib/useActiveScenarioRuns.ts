import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ScenarioExpectation } from "../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../data/providers/DataProvider";

export interface ActiveScenarioRun {
  connectorId: number;
  scenarioId: string;
  name: string;
  runId?: string;
  state: "running" | "paused" | "stepping" | "waiting";
  currentNodeId: string | null;
  currentNodeLabel: string | null;
  nodeCount: number | null;
  executedCount: number;
  expectation: ScenarioExpectation | null;
  currentNodeStartedAt: number | null;
}

const ACTIVE_STATES = ["running", "paused", "stepping", "waiting"] as const;

/** What we keep per scenario definition so repeat refreshes don't refetch it:
 *  node id → label, and the node count for the "k/N steps" display. */
interface CachedDefinition {
  labelsById: Map<string, string>;
  nodeCount: number;
}

/**
 * Tracks the scenario runs currently executing (or parked waiting) on a
 * charge point's connectors (#240). Queries listScenarios/getScenarioStatus
 * on mount and re-queries (debounced) whenever a scenario lifecycle event
 * arrives on the CP's event stream; live countdowns are the consumer's job
 * (compute from `currentNodeStartedAt` / `expectation.timeoutMs`).
 */
export function useActiveScenarioRuns(
  cpId: string | null,
  connectorIds: number[],
): { runs: ActiveScenarioRun[]; refresh: () => Promise<void> } {
  const { chargePointService } = useDataContext();

  const [runs, setRuns] = useState<ActiveScenarioRun[]>([]);
  const definitionCacheRef = useRef<Map<string, CachedDefinition>>(new Map());
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

    const fetchRun = async (
      connectorId: number,
      scenario: { scenarioId: string; name: string },
    ): Promise<ActiveScenarioRun | null> => {
      try {
        const status = await chargePointService.getScenarioStatus(
          cpId,
          connectorId,
          scenario.scenarioId,
        );
        if (
          !status ||
          !(ACTIVE_STATES as readonly string[]).includes(status.state)
        ) {
          return null;
        }

        const cacheKey = `${connectorId}:${scenario.scenarioId}`;
        let cached = definitionCacheRef.current.get(cacheKey);
        if (!cached) {
          const definition = await chargePointService.getScenario(
            cpId,
            connectorId,
            scenario.scenarioId,
          );
          if (definition) {
            cached = {
              labelsById: new Map(
                definition.nodes.map((n) => [n.id, n.data?.label ?? ""]),
              ),
              nodeCount: definition.nodes.length,
            };
            definitionCacheRef.current.set(cacheKey, cached);
          }
        }

        const currentNodeId = status.currentNodeId ?? null;
        return {
          connectorId,
          scenarioId: scenario.scenarioId,
          name: scenario.name,
          runId: status.runId,
          state: status.state as ActiveScenarioRun["state"],
          currentNodeId,
          currentNodeLabel: currentNodeId
            ? cached?.labelsById.get(currentNodeId) || currentNodeId
            : null,
          nodeCount: cached?.nodeCount ?? null,
          executedCount: status.executedNodes.length,
          expectation: status.expectation ?? null,
          currentNodeStartedAt: status.currentNodeStartedAt ?? null,
        };
      } catch (err) {
        console.warn(
          `Failed to fetch scenario status for ${cpId}/${connectorId}/${scenario.scenarioId}`,
          err,
        );
        return null;
      }
    };

    const perConnector = await Promise.all(
      ids.map(async (connectorId) => {
        try {
          const scenarios = await chargePointService.listScenarios(
            cpId,
            connectorId,
          );
          const runsForConnector = await Promise.all(
            scenarios
              .filter((s) => s.active)
              .map((scenario) => fetchRun(connectorId, scenario)),
          );
          return runsForConnector.filter(
            (r): r is ActiveScenarioRun => r !== null,
          );
        } catch (err) {
          console.warn(
            `Failed to list scenarios for ${cpId}/${connectorId}`,
            err,
          );
          return [];
        }
      }),
    );

    if (isMountedRef.current && requestId === requestIdRef.current) {
      setRuns(perConnector.flat());
    }
  }, [cpId, ids, chargePointService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!cpId) return undefined;

    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if (!(
        event.type === "scenario-started" ||
        event.type === "scenario-node-execute" ||
        event.type === "scenario-completed" ||
        event.type === "scenario-error"
      )) {
        return;
      }

      // Collapse bursts of node transitions into one re-query.
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
      refreshTimeoutRef.current = setTimeout(() => {
        void refresh();
      }, 200);
    });

    return () => {
      unsubscribe();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [cpId, chargePointService, refresh]);

  return { runs, refresh };
}
