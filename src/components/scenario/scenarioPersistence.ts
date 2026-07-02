import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { ScenarioRepository } from "../../cp/domain/persistence/ScenarioRepository";
import { serializeScenarioGraph } from "./scenarioSerialize";

/**
 * Dependencies needed to durably persist a scenario the user just loaded into
 * the editor. Narrowed to the handful of methods we call so tests can pass
 * lightweight mocks.
 */
export interface PersistEditorScenarioDeps {
  /** `"remote"` (daemon-backed) or `"local"` (browser sql.js). */
  mode: string;
  chargePointService: Pick<
    ChargePointService,
    "listScenarios" | "removeScenario" | "loadScenario"
  >;
  scenarioRepository: Pick<ScenarioRepository, "save">;
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
 * **Remote (daemon) mode:** the browser-side `scenarioRepository` is a no-op
 * (DataProvider constructs it with `database === null`), so a `repository.save`
 * here would silently vanish on reload and the daemon's `listScenarios` would
 * keep handing back the PREVIOUS scenario on the next mount. We push through the
 * daemon instead, and remove the prior scenarios so a stale one doesn't keep
 * winning index 0 (the daemon orders by insertion / updated_at).
 *
 * **Local mode:** upsert into the browser sql.js repository.
 *
 * `handleLoadTemplate` already did this; `handleFileChange` (upload) did not —
 * uploaded scenarios were lost on refresh in remote mode (GitHub #101). Sharing
 * one helper keeps both paths correct.
 */
export async function persistEditorScenario(
  deps: PersistEditorScenarioDeps,
  scenario: ScenarioDefinition,
): Promise<void> {
  const { mode, chargePointService, scenarioRepository, cpId, connectorId } =
    deps;
  const scenarioToPersist = serializeScenarioForPersistence(scenario);

  if (mode === "remote") {
    // The daemon's scenario RPCs are connector-scoped and require a positive
    // int (CP-level scenarios go through the local sql.js path), so narrow the
    // nullable editor connectorId here.
    const remoteConnectorId = connectorId as number;
    const existing = await chargePointService.listScenarios(
      cpId,
      remoteConnectorId,
    );
    await Promise.all(
      existing
        .filter((item) => item.scenarioId !== scenarioToPersist.id)
        .map((item) =>
          chargePointService
            .removeScenario(cpId, remoteConnectorId, item.scenarioId)
            .catch((err) =>
              console.warn(
                `Failed to remove stale scenario ${item.scenarioId}`,
                err,
              ),
            ),
        ),
    );
    await chargePointService.loadScenario(
      cpId,
      remoteConnectorId,
      scenarioToPersist,
    );
    return;
  }

  await scenarioRepository.save(cpId, connectorId, scenarioToPersist);
}

/**
 * Mode-aware upsert for the scenario currently being edited. Unlike
 * `persistEditorScenario`, this deliberately does not prune sibling daemon
 * scenarios: autosave/manual-save are updates to the open scenario, not a
 * replacement import/template operation.
 */
export async function saveEditorScenario(
  deps: PersistEditorScenarioDeps,
  scenario: ScenarioDefinition,
): Promise<void> {
  const { mode, chargePointService, scenarioRepository, cpId, connectorId } =
    deps;
  const scenarioToPersist = serializeScenarioForPersistence(scenario);

  if (mode === "remote") {
    const remoteConnectorId = connectorId as number;
    await chargePointService.loadScenario(
      cpId,
      remoteConnectorId,
      scenarioToPersist,
    );
    return;
  }

  await scenarioRepository.save(cpId, connectorId, scenarioToPersist);
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
