import type { ScenarioExpectation } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import { isLiveRunState, type LiveRunState } from "./scenarioRunState";

export interface ActiveScenarioRun {
  connectorId: number;
  scenarioId: string;
  name: string;
  runId?: string;
  state: LiveRunState;
  currentNodeId: string | null;
  currentNodeLabel: string | null;
  nodeCount: number | null;
  executedCount: number;
  expectation: ScenarioExpectation | null;
  currentNodeStartedAt: number | null;
  /** #240: when the parked wait times out; null without one. */
  waitDeadlineAt: number | null;
}

/** What we keep per scenario definition so repeat refreshes don't refetch it:
 *  node id → label, and the node count for the "k/N steps" display. */
export interface CachedDefinition {
  labelsById: Map<string, string>;
  nodeCount: number;
}

/** Definition cache of one charge point, keyed `<connectorId>:<scenarioId>`. */
export type DefinitionCache = Map<string, CachedDefinition>;

/**
 * Reads the live scenario runs (running, waiting, paused, stepping) on the
 * given connectors of one charge point: `listScenarios` per connector, then
 * `getScenarioStatus` for each active scenario. A connector or scenario that
 * fails to answer is skipped with a warning, so one bad answer never hides
 * the other runs. Shared by the per-charge-point hook and the cross-charge-
 * point one; each owns its `cache` (definitions are immutable per run, and a
 * rename shows on the next fetch of a new scenario).
 */
export async function fetchActiveRuns(
  service: ChargePointService,
  cpId: string,
  connectorIds: number[],
  cache: DefinitionCache,
): Promise<ActiveScenarioRun[]> {
  const fetchRun = async (
    connectorId: number,
    scenario: { scenarioId: string; name: string },
  ): Promise<ActiveScenarioRun | null> => {
    try {
      const status = await service.getScenarioStatus(
        cpId,
        connectorId,
        scenario.scenarioId,
      );
      if (!status || !isLiveRunState(status.state)) {
        return null;
      }

      const cacheKey = `${connectorId}:${scenario.scenarioId}`;
      let cached = cache.get(cacheKey);
      if (!cached) {
        const definition = await service.getScenario(
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
          cache.set(cacheKey, cached);
        }
      }

      const currentNodeId = status.currentNodeId ?? null;
      return {
        connectorId,
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        runId: status.runId,
        state: status.state,
        currentNodeId,
        currentNodeLabel: currentNodeId
          ? cached?.labelsById.get(currentNodeId) || currentNodeId
          : null,
        nodeCount: cached?.nodeCount ?? null,
        executedCount: status.executedNodes.length,
        expectation: status.expectation ?? null,
        currentNodeStartedAt: status.currentNodeStartedAt ?? null,
        waitDeadlineAt: status.waitDeadlineAt ?? null,
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
    connectorIds.map(async (connectorId) => {
      try {
        const scenarios = await service.listScenarios(cpId, connectorId);
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

  return perConnector.flat();
}
