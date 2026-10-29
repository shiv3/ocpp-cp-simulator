import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { RuntimeMode } from "../../data/RuntimeMode";
import { serializeScenarioGraph } from "./scenarioSerialize";
import { withNormalizedChargingCurve } from "../../cp/domain/connector/ChargingCurve";

export interface SaveEditorScenarioDeps {
  mode: RuntimeMode;
  chargePointService: Pick<
    ChargePointService,
    "saveScenarioDefinition" | "loadScenario"
  >;
  cpId: string;
  connectorId: number | null;
}

function serializeScenarioForPersistence(
  scenario: ScenarioDefinition,
): ScenarioDefinition {
  return {
    ...scenario,
    ...serializeScenarioGraph(scenario.nodes, scenario.edges),
  };
}

async function activateRemoteScenario(
  deps: {
    mode: RuntimeMode;
    chargePointService: Pick<ChargePointService, "loadScenario">;
    cpId: string;
    connectorId: number | null;
  },
  scenario: ScenarioDefinition,
): Promise<void> {
  const { mode, chargePointService, cpId, connectorId } = deps;
  if (mode !== "remote") return;
  // CP-level scenarios (connectorId === null) have no connector runtime to activate into; persistence already happened.
  if (connectorId === null) return;

  await chargePointService.loadScenario(cpId, connectorId, scenario);
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
  await activateRemoteScenario(deps, scenarioToPersist);
}

/**
 * Point an imported scenario at the connector it's being loaded into. A file
 * exported from another connector keeps its original `targetId`, which the
 * connector-scoped selection filters drop on the next refresh — so the upload
 * looks like it "didn't save" (#101). `now` is injected for testability and to
 * win the `updated_at DESC` ordering local mode lists by.
 *
 * This is also where an uploaded `chargingCurve` is normalized — sorted by
 * `socPercent`, invalid points dropped (#301). Its callers, the scenario
 * library's imports and per-connector copies (`toLibraryScenario`,
 * `makeLibraryCopy`), write the result straight to storage, so normalizing
 * here keeps the raw curve out of storage and of any export taken from it. Doing it at the import boundary rather than in each caller
 * is the arrangement {@link withNormalizedChargingCurve} exists to hold.
 *
 * The domain was never at risk — `Connector`'s `evSettings` setter normalizes
 * again on the way in — but storage and export do not sit behind that setter.
 *
 * `evSettings` is only rewritten when the file carried it, so a scenario
 * without EV settings does not gain an empty object it never had.
 */
export function retargetScenarioToConnector(
  scenario: ScenarioDefinition,
  connectorId: number | null,
  now: string,
): ScenarioDefinition {
  return {
    ...scenario,
    ...(scenario.evSettings
      ? { evSettings: withNormalizedChargingCurve({ ...scenario.evSettings }) }
      : {}),
    targetType: connectorId === null ? "chargePoint" : "connector",
    targetId: connectorId ?? undefined,
    updatedAt: now,
  };
}

/**
 * Load an already-persisted definition into a connector's runtime, for the
 * rare case where the runtime does not have it yet (a connector-assigned
 * Library copy whose `runScenario` answered "not found"). Persistence is not
 * touched: the copy is already stored, this only makes it runnable.
 */
export async function loadPersistedScenarioIntoRuntime(
  chargePointService: Pick<ChargePointService, "loadScenario">,
  cpId: string,
  connectorId: number,
  scenario: ScenarioDefinition,
): Promise<void> {
  await chargePointService.loadScenario(cpId, connectorId, scenario);
}
