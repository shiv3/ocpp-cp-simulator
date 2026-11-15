import * as path from "path";
import type { Params } from "@ocpp-cp-simulator/contracts/index";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { FileReloadManager } from "../FileReloadManager";
import type { RuntimeSocketIoDeps } from "../socketServer";
import {
  forgetWatchedConnectorScenarioFiles,
  forgetWatchedScenarioFile,
  rememberWatchedScenarioFile,
} from "../watchedScenarioFiles";
import { runFacadeOperation } from "./facadeErrors";

export async function listScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.list">,
): Promise<ScenarioDefinition[]> {
  return runFacadeOperation(() =>
    deps.chargePointService.listScenarioDefinitions(
      params.cpId,
      params.connectorId,
    ),
  );
}

export async function saveScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.save">,
): Promise<ScenarioDefinition> {
  const definition = params.definition as unknown as ScenarioDefinition;
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.saveScenarioDefinition(
      params.cpId,
      params.connectorId,
      definition,
    ),
  );
  await emitScenarioDefinitionsChanged(deps, params.cpId, params.connectorId);
  return saved;
}

/**
 * Stop the file behind one scenario from being authoritative, and forget the
 * row that would re-establish it (#314).
 *
 * Every path that takes a definition away from the daemon calls this, because
 * the alternative has now been three separate bugs with one shape: a definition
 * removed through one door while the file behind it kept its watch, so the next
 * edit put it back. The enumeration, so the fourth door is noticed when it is
 * added:
 *
 * - `remove_scenario` — removes runtime *and* stored definition.
 * - `load_scenario { scenario }` under an id a file already owns — replaces the
 *   runtime definition inline; the console becomes the source of truth.
 * - `scenario.definitions.delete` — removes only the stored row, leaving the
 *   runtime scenario loaded, so `stillLoaded` passes and a reload re-persists
 *   exactly what the operator deleted.
 * - `scenario.definitions.replace` — the whole connector at once; see
 *   {@link detachConnectorScenarioFiles}.
 *
 * `scenario.definitions.save` is an upsert and removes nothing.
 * `cp.delete` and `state.reset` are handled at the registry and schema level
 * instead, because they are about a charge point rather than one scenario.
 *
 * The watch and the row are dropped together and unconditionally: the row is a
 * fact about stored state, not about `--watch`, so a daemon running without the
 * flag still invalidates it.
 */
export function detachScenarioFile(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
  scenarioId: string,
): void {
  fileReload?.unregisterScenario(cpId, connectorId, scenarioId);
  forgetWatchedScenarioFile(database, cpId, connectorId, scenarioId);
}

/**
 * Record where a control-plane load got its scenario, and watch the file when
 * this daemon is watching (#314).
 *
 * The row goes in whether or not `--watch` is on, and that is the whole point:
 * it is a fact about stored state, not about the feature that consumes it.
 * Written only behind the flag, a `--state-db` daemon started without `--watch`
 * recorded no origin, and a later restart *with* `--watch` had nothing to
 * restore — the persisted scenario came back silently unwatched. This is the
 * same rule as {@link detachScenarioFile}'s unconditional delete, in the other
 * direction: both the writing and the clearing of the row are independent of
 * the watcher, and only the in-memory watch is behind the flag.
 *
 * The startup flags do not come through here: they own their keys and
 * deliberately store nothing — see `ScenarioFileRegistration.persist`.
 */
export function attachScenarioFile(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  registration: {
    readonly filePath: string;
    readonly cpId: string;
    readonly connectorId: number;
    readonly scenarioId: string;
    readonly loadedText?: string | null;
  },
): void {
  rememberWatchedScenarioFile(
    database,
    registration.cpId,
    registration.connectorId,
    registration.scenarioId,
    // Resolved the same way `registerScenarioFile` resolves it, so the row a
    // watcher writes and the row it reads back are the same string.
    path.resolve(registration.filePath),
  );
  fileReload?.registerScenarioFile(registration);
}

/**
 * The connector-wide twin of {@link detachScenarioFile}, for the upload that
 * replaces a connector's whole definition set.
 *
 * A CP-level (`connectorId === null`) scope is deliberately not handled: a
 * watch is only ever registered against a numeric connector, so no null-scoped
 * row can exist for one to invalidate.
 */
function detachConnectorScenarioFiles(
  fileReload: FileReloadManager | null | undefined,
  database: Database | null | undefined,
  cpId: string,
  connectorId: number,
): void {
  fileReload?.unregisterConnectorScenarios(cpId, connectorId);
  forgetWatchedConnectorScenarioFiles(database, cpId, connectorId);
}

export async function replaceConnectorScenarioDefinitions(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.replace">,
): Promise<ScenarioDefinition[]> {
  const definitions = params.definitions as unknown as ScenarioDefinition[];
  const saved = await runFacadeOperation(() =>
    deps.chargePointService.replaceConnectorScenarioDefinitions(
      params.cpId,
      params.connectorId,
      definitions,
    ),
  );
  // #314: the console has just become the source of truth for this connector's
  // whole definition set. A file still watched behind one of these ids would
  // overwrite the upload at its next edit.
  if (params.connectorId !== null) {
    detachConnectorScenarioFiles(
      deps.fileReload,
      deps.database,
      params.cpId,
      params.connectorId,
    );
  }
  deps.registryEvents?.emitScenarioDefinitionsChanged(
    params.cpId,
    params.connectorId,
    saved,
  );
  return saved;
}

export async function deleteScenarioDefinition(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.definitions.delete">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.deleteScenarioDefinition(
      params.cpId,
      params.connectorId,
      params.definitionId,
    ),
  );
  // #314: this deletes the stored row and leaves the runtime scenario loaded,
  // so without dropping the watch the next edit of the file behind it would
  // pass `stillLoaded`, reload, and persist the definition just deleted.
  if (params.connectorId !== null) {
    detachScenarioFile(
      deps.fileReload,
      deps.database,
      params.cpId,
      params.connectorId,
      params.definitionId,
    );
  }
  await emitScenarioDefinitionsChanged(deps, params.cpId, params.connectorId);
  return { ok: true };
}

/**
 * Used by save/delete, which only know the single definition they touched.
 * Unlike `replaceConnectorScenarioDefinitions` (whose own return value already
 * *is* the resulting full list), an upsert or a delete-by-id has no way to
 * know the connector's remaining full list without asking for it — this
 * query is the one unavoidable read, not a redundant one, so don't "optimize"
 * it away to match replace's call site without also giving save/delete a way
 * to produce the same answer for free.
 */
async function emitScenarioDefinitionsChanged(
  deps: RuntimeSocketIoDeps,
  cpId: string,
  connectorId: number | null,
): Promise<void> {
  if (!deps.registryEvents) return;
  const definitions = await runFacadeOperation(() =>
    deps.chargePointService.listScenarioDefinitions(cpId, connectorId),
  );
  deps.registryEvents.emitScenarioDefinitionsChanged(
    cpId,
    connectorId,
    definitions,
  );
}
