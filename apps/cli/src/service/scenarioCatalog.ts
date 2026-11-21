import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionMode,
  ScenarioExecutionState,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { legacyGeneratedBaseId } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/legacyStartupInstances";
import type { ScenarioRepository } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRepository";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import { getDefaultEVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import {
  scenarioTemplates,
  getTemplateById,
  summarizeTemplate,
  type ScenarioTemplateSummary,
} from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import { scenarioInstanceId } from "../scenarioInstanceId";
import type { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import {
  assertLoadableScenario,
  validateLoadableScenario,
} from "@ocpp-cp-simulator/core/scenario/loadableScenario";
import type { CLIChargePointService } from "../service";

/** What the scenario catalog functions need from `CLIChargePointService`. */
export interface ScenarioCatalogHost extends Pick<
  CLIChargePointService,
  | "loadScenario"
  | "loadScenarioTemplate"
  | "removeScenario"
  | "getScenarioStatus"
> {
  readonly chargePoint: ChargePoint;
  readonly database: Database | null;
  readonly scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  >;
  readonly executors: Map<string, ScenarioExecutor>;
  readonly runIdByScenario: Map<string, string>;
  readonly lastRunStatusByScenario: Map<string, ScenarioExecutionContext>;
  readonly recorder: ScenarioRunRecorder;
  readonly scenarioRepo: ScenarioRepository;
  tryAutoStartForConnector(
    connectorId: number,
    mode: "connect" | "status",
    connectorStatus: OCPPStatus | null,
  ): void;
}

export function getScenarioTemplates(): ReadonlyArray<ScenarioTemplateSummary> {
  return scenarioTemplates.map(summarizeTemplate);
}

/**
 * Instantiate the named template once per connector and run it through
 * loadScenario so it gets persisted. Used by CPRegistry.create to seed
 * a fresh CP with the canonical demo flow without each operator having
 * to pick it from the editor's template picker. Silently swallows
 * per-connector failures (e.g. template id changed since release) — a
 * busted seed shouldn't block CP creation.
 */
export function seedDefaultScenarios(
  host: ScenarioCatalogHost,
  templateId: string,
): void {
  for (const connectorId of host.chargePoint.connectors.keys()) {
    try {
      host.loadScenarioTemplate(templateId, connectorId);
    } catch (err) {
      process.stderr.write(
        `[CLI] seedDefaultScenarios(${templateId}) failed for connector ${connectorId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }
}

export function loadScenarioTemplate(
  host: ScenarioCatalogHost,
  templateId: string,
  connectorId: number,
  evSettingsOverride?: Partial<EVSettings>,
  options: {
    /** Forwarded to {@link loadScenario}: `false` keeps the auto-start gate
     *  out of a "load it and start it now" caller's way (#318). */
    readonly autoStart?: boolean;
    /** `false` loads the instance disabled: the auto-start walker skips it
     *  at every connect, so the only run is the explicit `run_scenario` the
     *  caller makes — a template that runs once, not on every reconnect
     *  (#352). */
    readonly enabled?: boolean;
  } = {},
): string {
  const template = getTemplateById(templateId);
  if (!template) {
    throw new Error(`Unknown template: ${templateId}`);
  }
  const definition = template.createScenario(host.chargePoint.id, connectorId);
  // Informational (schema 1.12): the template's wire shapes are written for
  // other OCPP versions than this charge point speaks. It still loads: some
  // flows work across versions, and refusing would break existing callers.
  const wireVersion = host.chargePoint.ocppVersion.replace(/^OCPP-/, "");
  const shortVersion = wireVersion.replace(/[JS]$/, "");
  if (!template.ocppVersions.includes(shortVersion)) {
    process.stderr.write(
      `[CLI] template ${templateId} is written for OCPP ${template.ocppVersions.join(" / ")}; this charge point speaks ${shortVersion}, so its wire shapes and assertions may not apply\n`,
    );
  }
  // Let callers pin e.g. maxChargingPowerKw without authoring a custom
  // scenario; otherwise the template's own evSettings clobber a prior
  // set_ev_settings when the scenario starts.
  if (evSettingsOverride) {
    definition.evSettings = {
      ...(definition.evSettings ?? getDefaultEVSettings()),
      ...evSettingsOverride,
    };
  }
  // Instantiating a template is idempotent per (template, connector): the
  // instance id is stable (#338), so loading the template again replaces the
  // previous instance under the same key instead of stacking one more copy —
  // the field report found three weeks-old Essential CP Behavior entries on
  // one connector when this id still embedded Date.now(). A startup
  // `--scenario-template` instance from a configuration no longer in force is
  // a different key, removed by the daemon's one startup prune.
  definition.id = scenarioInstanceId(templateId, connectorId);
  if (options.enabled === false) definition.enabled = false;
  // The instance an older build minted for the same template on this
  // connector (`<templateId>-<cpId>-c<n>-<epoch>-<suffix>`) is the one this
  // load replaces, as those builds removed it: left in place it would run
  // alongside the stable instance (#338).
  for (const [scenarioId, entry] of [...host.scenarios]) {
    if (
      entry.connectorId === connectorId &&
      legacyGeneratedBaseId(host.chargePoint.id, connectorId, scenarioId) ===
        templateId
    ) {
      host.removeScenario(connectorId, scenarioId);
    }
  }
  // Replacing an instance discards its in-flight run, as removing the
  // previous instance used to: a re-run must start the new definition, not
  // find the old executor still holding the id.
  discardScenarioRun(host, definition.id);
  return host.loadScenario(
    connectorId,
    definition,
    options.autoStart === undefined ? {} : { autoStart: options.autoStart },
  );
}

/**
 * Load a scenario onto a connector.
 *
 * `options.autoStart: false` suppresses the auto-start gate below. The one
 * caller that needs it is a "load this and run it *now, with these options*"
 * path (`run_scenario_file`): letting the gate start the scenario first left
 * the explicit start with nothing to do, so the caller's per-run options were
 * silently discarded and there was no way to tell that from a start this call
 * actually made (#314).
 */
export function loadScenario(
  host: ScenarioCatalogHost,
  connectorId: number,
  definition: ScenarioDefinition,
  options: {
    readonly autoStart?: boolean;
    /**
     * Called once when the durable write for this definition settles: `null`
     * on success, the error on failure. Optional so the synchronous contract
     * is unchanged for callers that do not report an outcome (#314).
     */
    readonly onPersisted?: (error: unknown | null) => void;
  } = {},
): string {
  // Hard gate on the fields the runtime map and every scenario RPC key on.
  // Without it a definition with no `id` was stored under the key
  // `undefined`, returned as `{}` instead of `{ scenarioId }`, and left an
  // entry in list_scenarios that could be neither run nor removed. Full
  // schema conformance stays advisory (issue #214) -- only this minimal set
  // is a gate. A missing `name` / `targetType` is filled in (the id,
  // "connector") and reported, as the web console's import always allowed.
  definition = assertLoadableScenario(definition, (message) =>
    process.stderr.write(
      `[CLI] loadScenario ${String(definition.id)}: ${message}\n`,
    ),
  );
  const connector = host.chargePoint.connectors.get(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  host.scenarios.set(definition.id, { definition, connectorId });
  // Persist asynchronously — the sql.js writer batches, and a sync
  // failure here would mask a successful in-memory load. `save` on the
  // bun:sqlite path is effectively sync but typed Promise; either way
  // a failure surfaces in stderr and the in-memory copy stays usable.
  //
  // `onPersisted` lets a caller that *reports an outcome* observe how that
  // write ended without changing this method's synchronous contract for the
  // callers that do not care. `--watch` is the one that does: it announces
  // `applied` and advances its duplicate-suppression baseline, and both of
  // those are claims about durable state, so a swallowed `SQLITE_BUSY` made
  // it announce a change a restart undoes and then suppress the operator's
  // retry of the very same bytes (#314). Called exactly once, with `null` on
  // success and the error on failure.
  //
  // Exactly once means the *report* is separated from the outcome. A
  // `.then().catch()` chain does not do that: `.catch` also sees anything the
  // success handler throws, so a durable write that landed and then hit a
  // throwing callback was logged as a persistence failure and reported a
  // second time — as `rejected`. `--watch`'s callback reaches
  // `eventEnvelopeSchema.parse`, which throws on an oversized snapshot, so
  // that path was reachable and it inverted this method's whole guarantee:
  // `applied` means the bytes landed, and a failure to *announce* is not a
  // failure to persist. The rejection handler is the second argument to
  // `.then` so it only ever sees the write's own failure, and the callback
  // itself is invoked inside a guard so a throw can neither be re-reported
  // nor escape as an unhandled rejection (#314).
  const reportPersisted = (error: unknown | null): void => {
    try {
      options.onPersisted?.(error);
    } catch (callbackErr) {
      process.stderr.write(
        `[CLI] onPersisted callback for scenario ${definition.id} threw: ${
          callbackErr instanceof Error ? callbackErr.message : callbackErr
        }\n`,
      );
    }
  };
  void host.scenarioRepo
    .save(host.chargePoint.id, connectorId, definition)
    .then(
      () => {
        reportPersisted(null);
      },
      (err: unknown) => {
        process.stderr.write(
          `[CLI] Failed to persist scenario ${definition.id}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
        reportPersisted(err);
      },
    );
  // Scenarios may be loaded after the CP is already connected (e.g. via
  // the JSON `load_scenario` command on a long-running daemon). The CP
  // statusChange event won't refire, so kick the auto-start gate here
  // too — it's idempotent thanks to the dedup key.
  if (
    options.autoStart !== false &&
    host.chargePoint.status === OCPPStatus.Available
  ) {
    host.tryAutoStartForConnector(connectorId, "connect", null);
    host.tryAutoStartForConnector(connectorId, "status", connector.status);
  }
  return definition.id;
}

/**
 * Snapshot of every loaded (connectorId, ScenarioDefinition) pair. Used
 * by CPRegistry.update to carry the in-memory scenarios across a
 * cleanup() → new instantiate() rebuild when the daemon is running
 * without --state-db (no `scenarios` table to rehydrate from). The
 * definitions are returned by-reference because they are read-only
 * snapshots of the operator's last load; the new service's
 * loadScenario clones them as needed.
 */
export function snapshotScenarios(host: ScenarioCatalogHost): ReadonlyArray<{
  readonly connectorId: number;
  readonly definition: ScenarioDefinition;
}> {
  return Array.from(host.scenarios.values()).map((entry) => ({
    connectorId: entry.connectorId,
    definition: entry.definition,
  }));
}

/**
 * Rehydrate all scenarios that were persisted for this CP under the
 * given (cp_id, connector_id) by a previous daemon run. Called from
 * CPRegistry.restoreFromDatabase() after a CP is re-instantiated, so a
 * restart picks up every loaded scenario — and any statusChange-trigger
 * scenarios re-arm automatically via attachStatusChangeAutoTrigger().
 */
export function restoreScenariosFromDatabase(
  host: ScenarioCatalogHost,
): number {
  if (!host.database) return 0;
  let total = 0;
  host.chargePoint.connectors.forEach((_connector, connectorId) => {
    const defs = host.scenarioRepo.listByConnector(
      host.chargePoint.id,
      connectorId,
    );
    for (const def of defs) {
      // Skip already-loaded scenarios so calling this twice is a no-op.
      if (host.scenarios.has(def.id)) continue;
      host.scenarios.set(def.id, { definition: def, connectorId });
      total += 1;
    }
  });
  return total;
}

/**
 * Drop a scenario from in-memory state AND the DB. The interface's
 * `delete(cpId, connectorId)` would wipe every scenario on that
 * connector — operators expect to delete just one, so we go through
 * `deleteOne`.
 */
export function removeScenario(
  host: ScenarioCatalogHost,
  connectorId: number,
  scenarioId: string,
): boolean {
  const entry = host.scenarios.get(scenarioId);
  if (!entry || entry.connectorId !== connectorId) return false;
  discardScenarioRun(host, scenarioId);
  host.scenarios.delete(scenarioId);
  host.scenarioRepo.deleteOne(host.chargePoint.id, connectorId, scenarioId);
  return true;
}

/**
 * Tear down any in-flight run for `scenarioId` — stop the executor and drop
 * its transcript subscription so it doesn't keep capturing WebSocket frames.
 * No verdict is computed: the run is being discarded (scenario deleted or its
 * definition replaced). A no-op when nothing is running for the id.
 */
export function discardScenarioRun(
  host: ScenarioCatalogHost,
  scenarioId: string,
): void {
  // The run is being thrown away, so its terminal status must go too --
  // otherwise scenario_status would keep reporting a "completed" run for a
  // scenario whose definition was replaced underneath it. Done outside the
  // executor guard: a scenario can have a recorded terminal status with no
  // live executor, which is the whole point of that map.
  host.lastRunStatusByScenario.delete(scenarioId);
  const executor = host.executors.get(scenarioId);
  if (!executor) return;
  executor.stop();
  host.executors.delete(scenarioId);
  // #448: a discarded run never reaches finalizeScenarioRun, so end it on
  // the timeline here, or the connector's later entries keep its runId.
  const runId = host.runIdByScenario.get(scenarioId);
  const connectorId = host.scenarios.get(scenarioId)?.connectorId;
  if (runId !== undefined && connectorId !== undefined) {
    host.chargePoint.timeline.endRun(connectorId, runId);
  }
  host.runIdByScenario.delete(scenarioId);
  if (connectorId !== undefined) {
    host.recorder.discard(scenarioId, connectorId);
  }
}

/**
 * Reconcile the in-memory runtime scenario map for `connectorId` to exactly
 * the given (already-persisted) definitions — issue #209.
 *
 * The Remote/Docker web-console upload persists definitions via the registry
 * service's replaceConnectorScenarioDefinitions but does NOT touch this
 * daemon runtime map, which is what connect-auto-start (tryAutoStartForConnector)
 * reads. So after an upload the runtime still holds the stale seeded default
 * (`essential-cp-behavior`) and lacks the uploaded scenario — the operator's
 * connect-triggered scenario intermittently never fires. This syncs the
 * runtime so connect-auto-start sees the upload. In-memory only: the caller
 * already made the DB authoritative.
 */
export function syncConnectorRuntimeScenarios(
  host: ScenarioCatalogHost,
  connectorId: number | null,
  definitions: readonly ScenarioDefinition[],
): void {
  // The runtime map is keyed to numeric connectors (loadScenario requires a
  // connector). CP-level (null) uploads have no connector runtime entries to
  // reconcile; skip them.
  if (connectorId === null) return;
  const keepIds = new Set(definitions.map((d) => d.id));
  // Reconcile runtime entries for this connector scope (in-memory only). Any
  // in-flight run is discarded first — the definition set is being replaced,
  // and a lingering executor would also block auto-start via the
  // active-executor gate in tryAutoStartForConnector.
  for (const [scenarioId, entry] of [...host.scenarios]) {
    if (entry.connectorId !== connectorId) continue;
    discardScenarioRun(host, scenarioId);
    if (!keepIds.has(scenarioId)) host.scenarios.delete(scenarioId);
  }
  // Load the provided definitions into runtime (already persisted upstream).
  // Definitions arriving here were persisted by the console-upload path,
  // which does not go through loadScenario's gate — so skip anything that
  // would land in the runtime map unaddressable (no usable `id`, no nodes
  // array). Skipped rather than thrown: this reconciles a whole set that is
  // already the DB's truth, and one bad entry must not fail the others.
  for (const def of definitions) {
    const check = validateLoadableScenario(def);
    if (!check.valid || !check.definition) {
      process.stderr.write(
        `[CLI] syncConnectorRuntimeScenarios: skipping unloadable definition on connector ${connectorId}: ${check.errors.join("; ")}\n`,
      );
      continue;
    }
    // A missing name / targetType is filled in, as loadScenario does.
    host.scenarios.set(check.definition.id, {
      definition: check.definition,
      connectorId,
    });
  }
  // The replaced set may drop whatever auto-started last, so clear the dedup
  // key and — if the CP is already up — kick auto-start for the new set.
  const connector = host.chargePoint.connectors.get(connectorId);
  if (!connector) return;
  connector.lastAutoStartedScenarioKey = null;
  if (host.chargePoint.status === OCPPStatus.Available) {
    host.tryAutoStartForConnector(connectorId, "connect", null);
    host.tryAutoStartForConnector(connectorId, "status", connector.status);
  }
}

/**
 * Every scenario loaded on `connectorId`.
 *
 * `state` and `mode` come from the same source as `scenario_status` — the
 * live executor while a run is in flight, otherwise the last finished run —
 * so a caller can see at a glance which scenarios have run and how they
 * ended, without a status round-trip per id. Both are null for a scenario
 * that has never run.
 */
export function listScenarios(
  host: ScenarioCatalogHost,
  connectorId: number,
): ReadonlyArray<{
  readonly scenarioId: string;
  readonly name: string;
  readonly active: boolean;
  readonly state: ScenarioExecutionState | null;
  readonly mode: ScenarioExecutionMode | null;
}> {
  const result: Array<{
    readonly scenarioId: string;
    readonly name: string;
    readonly active: boolean;
    readonly state: ScenarioExecutionState | null;
    readonly mode: ScenarioExecutionMode | null;
  }> = [];
  for (const [scenarioId, entry] of host.scenarios) {
    if (entry.connectorId === connectorId) {
      const status = host.getScenarioStatus(connectorId, scenarioId);
      result.push({
        scenarioId,
        name: entry.definition.name,
        active: host.executors.has(scenarioId),
        state: status?.state ?? null,
        mode: status?.mode ?? null,
      });
    }
  }
  return result;
}
