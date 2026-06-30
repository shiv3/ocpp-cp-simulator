import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import { serializeScenarioGraph } from "./scenarioSerialize";

/**
 * Dependencies needed to durably persist a scenario the user just loaded into
 * the editor. Narrowed to the handful of methods we call so tests can pass
 * lightweight mocks.
 */
export interface PersistEditorScenarioDeps {
  chargePointService: Pick<
    ChargePointService,
    "listScenarioDefinitions" | "replaceConnectorScenarioDefinitions"
  >;
  cpId: string;
  connectorId: number | null;
}

export interface SaveEditorScenarioDeps {
  chargePointService: Pick<ChargePointService, "saveScenarioDefinition">;
  cpId: string;
  connectorId: number | null;
}

export function createLatestWinsSaver<T>(
  saveFn: (payload: T) => Promise<void>,
): (payload: T) => Promise<void> {
  let latestSeq = 0;
  let tail: Promise<void> = Promise.resolve();

  return (payload: T): Promise<void> => {
    const seq = ++latestSeq;
    const next = tail
      .catch(() => undefined)
      .then(async () => {
        if (seq !== latestSeq) return;
        await saveFn(payload);
      });
    tail = next;
    return next;
  };
}

function serializeScenarioForPersistence(
  scenario: ScenarioDefinition,
): ScenarioDefinition {
  return {
    ...scenario,
    ...serializeScenarioGraph(scenario.nodes, scenario.edges),
  };
}

/**
 * Durably persist a scenario the user just dropped into the editor — either by
 * uploading a JSON file (`handleFileChange`) or loading a template
 * (`handleLoadTemplate`).
 *
 * This is the editor's replace operation: stale sibling definitions for the
 * connector are pruned and the incoming definition becomes the complete
 * persisted set. The service port owns whether that means browser sql.js or the
 * daemon SQLite store.
 */
export async function persistEditorScenario(
  deps: PersistEditorScenarioDeps,
  scenario: ScenarioDefinition,
): Promise<void> {
  const { chargePointService, cpId, connectorId } = deps;
  const scenarioToPersist = serializeScenarioForPersistence(scenario);

  await chargePointService.listScenarioDefinitions(cpId, connectorId);
  await chargePointService.replaceConnectorScenarioDefinitions(
    cpId,
    connectorId,
    [scenarioToPersist],
  );
}

/**
 * Upsert the scenario currently being edited without pruning sibling
 * definitions. Used for explicit single-definition edits.
 */
export async function saveEditorScenario(
  deps: SaveEditorScenarioDeps,
  scenario: ScenarioDefinition,
): Promise<void> {
  const { chargePointService, cpId, connectorId } = deps;
  const scenarioToPersist = serializeScenarioForPersistence(scenario);

  await chargePointService.saveScenarioDefinition(
    cpId,
    connectorId,
    scenarioToPersist,
  );
}

/**
 * Point an imported scenario at the connector it's being loaded into. A file
 * exported from another connector keeps its original `targetId`, which the
 * connector-scoped selection filters drop on the next refresh — so the upload
 * looks like it "didn't save" (#101). `now` is injected for testability and to
 * win the `updated_at DESC` ordering local mode lists by.
 */
export function retargetScenarioToConnector(
  scenario: ScenarioDefinition,
  connectorId: number | null,
  now: string,
): ScenarioDefinition {
  return {
    ...scenario,
    targetType: connectorId === null ? "chargePoint" : "connector",
    targetId: connectorId ?? undefined,
    updatedAt: now,
  };
}
