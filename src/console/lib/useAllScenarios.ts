import { useCallback, useEffect, useState } from "react";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../../data/providers/DataProvider";

/**
 * One scenario definition plus the (cpId, connectorId) scope it was loaded
 * from. `connectorId` is `null` for chargePoint-scope scenarios — this
 * mirrors the `connectorId` parameter of
 * `chargePointService.listScenarioDefinitions` / `saveScenarioDefinition`,
 * not `scenario.targetId` (which is only set for connector-scope
 * scenarios). See `SqliteScenarioRepository.listByConnector`: rows are
 * queried by `connector_id = (connectorId ?? 0)`, so `null` and a given
 * connector number are mutually exclusive, exhaustive scopes per CP.
 */
export interface ScenarioLibraryItem {
  cpId: string;
  connectorId: number | null;
  scenario: ScenarioDefinition;
}

export interface UseAllScenariosResult {
  items: ScenarioLibraryItem[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (
    cpId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ) => Promise<void>;
  remove: (
    cpId: string,
    connectorId: number | null,
    scenarioId: string,
  ) => Promise<void>;
}

/**
 * Enumerates every scenario definition across every registered charge
 * point, for the cross-CP Scenario Library page (Task 6). There is no
 * single "list all scenarios" service method — scenarios are always
 * queried per (cpId, connectorId) scope — so this walks every CP returned
 * by `listChargePoints()` and, for each, queries the chargePoint scope
 * (`connectorId: null`) plus one connector scope per `cp.connectors`
 * entry.
 *
 * A scenario.id can legitimately appear more than once across scopes only
 * as stale/inconsistent data (it shouldn't under normal use); de-duping
 * keeps the first occurrence encountered by this CP/connector walk order.
 */
export function useAllScenarios(): UseAllScenariosResult {
  const { chargePointService } = useDataContext();
  const [items, setItems] = useState<ScenarioLibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const chargePoints = await chargePointService.listChargePoints();

      const perCp = await Promise.all(
        chargePoints.map(async (cp) => {
          const scopes: Array<number | null> = [
            null,
            ...cp.connectors.map((connector) => connector.id),
          ];
          const defsByScope = await Promise.all(
            scopes.map(async (connectorId) => {
              const defs = await chargePointService.listScenarioDefinitions(
                cp.id,
                connectorId,
              );
              // Defensive: real service implementations always resolve an
              // array, but test doubles that don't stub this method (the
              // harness's catch-all `vi.fn(async () => undefined)`) resolve
              // `undefined` — don't let that blow up the walk.
              return defs ?? [];
            }),
          );
          return scopes.map((connectorId, index) => ({
            cpId: cp.id,
            connectorId,
            defs: defsByScope[index],
          }));
        }),
      );

      const seen = new Set<string>();
      const collected: ScenarioLibraryItem[] = [];
      for (const cpScopes of perCp) {
        for (const { cpId, connectorId, defs } of cpScopes) {
          for (const scenario of defs) {
            if (seen.has(scenario.id)) continue;
            seen.add(scenario.id);
            collected.push({ cpId, connectorId, scenario });
          }
        }
      }

      setItems(collected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [chargePointService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (
      cpId: string,
      connectorId: number | null,
      scenario: ScenarioDefinition,
    ) => {
      await chargePointService.saveScenarioDefinition(
        cpId,
        connectorId,
        scenario,
      );
      await refresh();
    },
    [chargePointService, refresh],
  );

  const remove = useCallback(
    async (cpId: string, connectorId: number | null, scenarioId: string) => {
      // Atomic delete-by-id, not read-filter-replace: a whole-list write
      // here would race a concurrent delete of a *different* scenario in
      // the same (cpId, connectorId) scope — both reads happen before
      // either write lands, so the second write resurrects the first
      // deletion.
      await chargePointService.deleteScenarioDefinition(
        cpId,
        connectorId,
        scenarioId,
      );
      await refresh();
    },
    [chargePointService, refresh],
  );

  return { items, isLoading, error, refresh, save, remove };
}

/**
 * Builds the fixed nav URL for the scenario editor/run routes (Task 1's
 * route contract). `connector` is always present in the query string, as
 * an empty value for chargePoint-scope scenarios — not omitted — to match
 * the brief's exact `?cp=&connector=&id=` shape.
 */
export function buildScenarioUrl(
  kind: "edit" | "run",
  cpId: string,
  connectorId: number | null,
  scenarioId: string,
): string {
  const params = new URLSearchParams();
  params.set("cp", cpId);
  params.set("connector", connectorId != null ? String(connectorId) : "");
  params.set("id", scenarioId);
  return `/scenarios/${kind}?${params.toString()}`;
}
