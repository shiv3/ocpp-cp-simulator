import { retargetScenarioToConnector } from "../../components/scenario/scenarioPersistence";
import { serializeScenarioGraph } from "../../components/scenario/scenarioSerialize";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { ChargePointRun } from "./useAllActiveScenarioRuns";
import { buildScenarioUrl, type ScenarioLibraryItem } from "./useAllScenarios";

/**
 * The Scenario Library's data model, kept behind these helpers so the storage
 * choice can change without touching the pages.
 *
 * A **library scenario** is a `ScenarioDefinition` stored through the
 * ordinary per-scope definition API under a reserved charge point id,
 * {@link LIBRARY_SCOPE}, with `connectorId = null`. Both services accept any
 * id there: no charge point is ever instantiated for it, `state.reset` wipes
 * it with everything else and `cp.delete` never touches it.
 *
 * A connector **uses** a library scenario when its own scope holds a copy
 * tagged with `libraryId` (see {@link makeLibraryCopy}). That copy is what the
 * runtime, auto-start and `listScenarios` read, so assigning one is a plain
 * `replaceConnectorScenarioDefinitions`.
 */
export const LIBRARY_SCOPE = "__library__";

export function isLibraryScope(cpId: string): boolean {
  return cpId === LIBRARY_SCOPE;
}

type DefinitionService = Pick<
  ChargePointService,
  | "listScenarioDefinitions"
  | "saveScenarioDefinition"
  | "replaceConnectorScenarioDefinitions"
  | "deleteScenarioDefinition"
>;

/** A scope's definitions; a test double that resolves nothing reads as []. */
export async function listScopeDefinitions(
  service: Pick<ChargePointService, "listScenarioDefinitions">,
  cpId: string,
  connectorId: number | null,
): Promise<ScenarioDefinition[]> {
  return (await service.listScenarioDefinitions(cpId, connectorId)) ?? [];
}

export function listLibraryScenarios(
  service: Pick<ChargePointService, "listScenarioDefinitions">,
): Promise<ScenarioDefinition[]> {
  return listScopeDefinitions(service, LIBRARY_SCOPE, null);
}

/** Deterministic, so assigning the same scenario again replaces the copy
 *  instead of stacking a second one. */
export function libraryCopyId(
  libraryId: string,
  cpId: string,
  connectorId: number | null,
): string {
  return `${libraryId}@${cpId}#${connectorId ?? "cp"}`;
}

/** The graph without the fields ReactFlow and the executor add at runtime —
 *  what `saveEditorScenario` persists too. */
function serialized(def: ScenarioDefinition): ScenarioDefinition {
  return { ...def, ...serializeScenarioGraph(def.nodes, def.edges) };
}

/**
 * A scenario as a library entry: no connector target (`targetType`
 * "connector", no `targetId`) and no `libraryId`. Used for imports, templates
 * and the migration; the charging curve is normalized on the way in, as for
 * any import.
 */
export function toLibraryScenario(
  scenario: ScenarioDefinition,
  now: string,
): ScenarioDefinition {
  const {
    targetId: _targetId,
    libraryId: _libraryId,
    ...rest
  } = retargetScenarioToConnector(scenario, null, now);
  return { ...rest, targetType: "connector" };
}

/** The per-connector copy of a library scenario: retargeted, tagged with
 *  `libraryId`, and under `id` (default: {@link libraryCopyId}). */
export function makeLibraryCopy(
  libraryScenario: ScenarioDefinition,
  cpId: string,
  connectorId: number | null,
  now: string,
  id: string = libraryCopyId(libraryScenario.id, cpId, connectorId),
): ScenarioDefinition {
  return {
    ...retargetScenarioToConnector(
      serialized(libraryScenario),
      connectorId,
      now,
    ),
    id,
    libraryId: libraryScenario.id,
  };
}

/**
 * Makes the connector's persisted set exactly one copy of `libraryScenario`
 * (or empty with null). In Remote mode the daemon also reloads the
 * connector's runtime from the new set, discarding a run in flight; in Local
 * mode the runtime follows the store.
 */
export async function assignLibraryScenario(
  service: Pick<ChargePointService, "replaceConnectorScenarioDefinitions">,
  cpId: string,
  connectorId: number,
  libraryScenario: ScenarioDefinition | null,
  now: string = new Date().toISOString(),
): Promise<ScenarioDefinition | null> {
  const copy = libraryScenario
    ? makeLibraryCopy(libraryScenario, cpId, connectorId, now)
    : null;
  await service.replaceConnectorScenarioDefinitions(
    cpId,
    connectorId,
    copy ? [copy] : [],
  );
  return copy;
}

/** The library scenario a connector's scope uses, from its definitions. */
export function assignedLibraryId(
  definitions: readonly ScenarioDefinition[],
): string | null {
  return definitions.find((d) => d.libraryId)?.libraryId ?? null;
}

/** Every (charge point, connector) whose scope holds a copy of `libraryId`. */
export function usedBy(
  items: readonly ScenarioLibraryItem[],
  libraryId: string,
): ScenarioLibraryItem[] {
  return items.filter(
    (item) =>
      !isLibraryScope(item.cpId) && item.scenario.libraryId === libraryId,
  );
}

/** The live runs of `libraryId`'s copies. A charge-point-scope copy runs on
 *  any connector of its charge point. */
export function runsOfLibraryScenario(
  runs: readonly ChargePointRun[],
  items: readonly ScenarioLibraryItem[],
  libraryId: string,
): ChargePointRun[] {
  const copies = usedBy(items, libraryId);
  return runs.filter((run) =>
    copies.some(
      (copy) =>
        copy.cpId === run.cpId &&
        copy.scenario.id === run.scenarioId &&
        (copy.connectorId === null || copy.connectorId === run.connectorId),
    ),
  );
}

/** A user of a library scenario as the editor shows it: a connector (or a
 *  charge point scope) and whether a run of its copy is live there. */
export interface LibraryUserState {
  cpId: string;
  connectorId: number | null;
  running: boolean;
}

/** The users of `libraryId`, each marked when its copy is running. */
export function libraryEditorUsers(
  items: readonly ScenarioLibraryItem[],
  runs: readonly ChargePointRun[],
  libraryId: string,
): LibraryUserState[] {
  return usedBy(items, libraryId).map((user) => ({
    cpId: user.cpId,
    connectorId: user.connectorId,
    running: runs.some(
      (run) =>
        run.cpId === user.cpId &&
        run.scenarioId === user.scenario.id &&
        (user.connectorId === null || run.connectorId === user.connectorId),
    ),
  }));
}

/**
 * Re-pushes an edited library scenario to one user, keeping the copy's own id
 * (a migrated copy has its original one) and any sibling definitions of the
 * scope. A connector scope goes through `replace…` so the daemon reloads its
 * runtime; a charge point scope has no runtime to reload and is upserted.
 */
async function repushCopy(
  service: DefinitionService,
  user: ScenarioLibraryItem,
  libraryScenario: ScenarioDefinition,
  now: string,
): Promise<void> {
  const copy = makeLibraryCopy(
    libraryScenario,
    user.cpId,
    user.connectorId,
    now,
    user.scenario.id,
  );
  if (user.connectorId === null) {
    await service.saveScenarioDefinition(user.cpId, null, copy);
    return;
  }
  const current = await listScopeDefinitions(
    service,
    user.cpId,
    user.connectorId,
  );
  const next = current.some((d) => d.id === copy.id)
    ? current.map((d) => (d.id === copy.id ? copy : d))
    : [copy, ...current];
  await service.replaceConnectorScenarioDefinitions(
    user.cpId,
    user.connectorId,
    next,
  );
}

/** Saves a library entry, then re-pushes the copy to every user in parallel. */
export async function saveLibraryScenario(
  service: DefinitionService,
  scenario: ScenarioDefinition,
  users: readonly ScenarioLibraryItem[],
  now: string = new Date().toISOString(),
): Promise<void> {
  const entry = serialized(scenario);
  await service.saveScenarioDefinition(LIBRARY_SCOPE, null, entry);
  await Promise.all(users.map((user) => repushCopy(service, user, entry, now)));
}

/** Un-assigns every user (only the copy leaves a scope; siblings stay), then
 *  deletes the library entry. */
export async function deleteLibraryScenario(
  service: DefinitionService,
  libraryId: string,
  users: readonly ScenarioLibraryItem[],
): Promise<void> {
  await Promise.all(
    users.map(async (user) => {
      if (user.connectorId === null) {
        await service.deleteScenarioDefinition(
          user.cpId,
          null,
          user.scenario.id,
        );
        return;
      }
      const current = await listScopeDefinitions(
        service,
        user.cpId,
        user.connectorId,
      );
      await service.replaceConnectorScenarioDefinitions(
        user.cpId,
        user.connectorId,
        current.filter((d) => d.id !== user.scenario.id),
      );
    }),
  );
  await service.deleteScenarioDefinition(LIBRARY_SCOPE, null, libraryId);
}

export interface MigrationResult {
  /** The library entries created. */
  created: ScenarioDefinition[];
  /** How many per-connector definitions were tagged with a `libraryId`. */
  tagged: number;
}

/**
 * One-time move to the Library for state written before it existed: when the
 * library is empty but charge points hold definitions, each distinct one
 * (keyed by `templateId ?? name`) becomes a library entry, and every
 * per-connector definition is re-saved with `libraryId` set to its entry,
 * keeping its own id. Idempotent: a non-empty library makes it a no-op.
 */
export async function migrateToLibrary(
  service: DefinitionService,
  library: readonly ScenarioDefinition[],
  items: readonly ScenarioLibraryItem[],
  options: { makeId?: () => string; now?: string } = {},
): Promise<MigrationResult> {
  const sources = items.filter((item) => !isLibraryScope(item.cpId));
  if (library.length > 0 || sources.length === 0) {
    return { created: [], tagged: 0 };
  }
  const makeId = options.makeId ?? (() => crypto.randomUUID());
  const now = options.now ?? new Date().toISOString();

  const keyOf = (scenario: ScenarioDefinition) =>
    scenario.templateId ?? scenario.name;
  const entries = new Map<string, ScenarioDefinition>();
  for (const { scenario } of sources) {
    const key = keyOf(scenario);
    if (entries.has(key)) continue;
    entries.set(key, { ...toLibraryScenario(scenario, now), id: makeId() });
  }
  const created = [...entries.values()];
  for (const entry of created) {
    await service.saveScenarioDefinition(LIBRARY_SCOPE, null, entry);
  }

  let tagged = 0;
  await Promise.all(
    sources.map(async ({ cpId, connectorId, scenario }) => {
      const entry = entries.get(keyOf(scenario))!;
      if (scenario.libraryId === entry.id) return;
      await service.saveScenarioDefinition(cpId, connectorId, {
        ...scenario,
        libraryId: entry.id,
      });
      tagged += 1;
    }),
  );
  return { created, tagged };
}

/** The Library tab with the inline editor open on `libraryId`. */
export function libraryEditorUrl(libraryId: string): string {
  const params = new URLSearchParams();
  params.set("tab", "library");
  params.set("edit", libraryId);
  return `/scenarios?${params.toString()}`;
}

/** The definition an edit of `scenario` (in the scope `cpId` /
 *  `connectorId`) applies to: the Library entry for a library entry or a copy
 *  of one (edits are made once, in the Library), else the scenario itself. */
export interface ScenarioEditTarget {
  cpId: string;
  connectorId: number | null;
  scenarioId: string;
  /** True when the target is a Library entry (`cpId` is the Library). */
  library: boolean;
}

export function scenarioEditTarget(
  cpId: string,
  connectorId: number | null,
  scenario: Pick<ScenarioDefinition, "id" | "libraryId">,
): ScenarioEditTarget {
  if (isLibraryScope(cpId)) {
    return {
      cpId: LIBRARY_SCOPE,
      connectorId: null,
      scenarioId: scenario.id,
      library: true,
    };
  }
  if (scenario.libraryId) {
    return {
      cpId: LIBRARY_SCOPE,
      connectorId: null,
      scenarioId: scenario.libraryId,
      library: true,
    };
  }
  return { cpId, connectorId, scenarioId: scenario.id, library: false };
}

/**
 * Where **Edit scenario** goes on a page: the Library editor for a library
 * entry or a copy of one, else the per-connector editor (see
 * {@link scenarioEditTarget}).
 */
export function editScenarioUrl(
  cpId: string,
  connectorId: number | null,
  scenario: Pick<ScenarioDefinition, "id" | "libraryId">,
): string {
  const target = scenarioEditTarget(cpId, connectorId, scenario);
  if (target.library) return libraryEditorUrl(target.scenarioId);
  return buildScenarioUrl("edit", cpId, connectorId, scenario.id);
}
