import type { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { FileReloadManager } from "./FileReloadManager";
import { forgetWatchedScenarioFile } from "./watchedScenarioFiles";
import {
  deleteScenarioRow,
  listStartupScenarioRows,
  loadWithStartupProvenance,
} from "./startupScenarioRows";
import { scenarioInstanceId } from "../scenarioInstanceId";
import { LEGACY_STARTUP_SOURCE_PREFIX } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/legacyStartupInstances";
import { getTemplateById } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import * as path from "path";
import type { ServerOptions } from "./startServer";
import {
  readStartupScenarioFile,
  resolveStartupScenarioMode,
  startupScenarioOptionConflict,
  type StartupScenarioFile,
  type StartupScenarioMode,
} from "./startupScenarioMode";

export {
  readStartupScenarioFile,
  resolveStartupScenarioMode,
  startupScenarioOptionConflict,
};
export type { StartupScenarioFile, StartupScenarioMode };

/**
 * Resolve a `--scenario-connector` value ("all" | "1" | "1,2,3") to an
 * explicit list of connector ids in [1..connectorCount]. Silently skips
 * out-of-range values and de-duplicates.
 */
function resolveConnectorIds(raw: string, connectorCount: number): number[] {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "all") {
    const ids: number[] = [];
    for (let i = 1; i <= connectorCount; i++) ids.push(i);
    return ids;
  }
  const seen = new Set<number>();
  for (const part of trimmed.split(",")) {
    const n = parseInt(part, 10);
    if (Number.isInteger(n) && n >= 1 && n <= connectorCount) {
      seen.add(n);
    }
  }
  return [...seen];
}

/**
 * Issue #214: advisory (warning-only) schema check for a scenario file read
 * from disk at startup. Never throws and never blocks loading — a schema
 * mismatch is logged to stderr and the caller proceeds exactly as it would
 * have before this check existed.
 */
function warnOnScenarioSchemaMismatch(source: string, value: unknown): void {
  const result = validateScenarioSchema(value);
  if (!result.valid) {
    process.stderr.write(
      `[server] Warning: "${source}" does not match packages/core/schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}\n`,
    );
  }
}

/**
 * Start `scenarioId` unless it's already running. Loading a scenario
 * (loadScenario/loadScenarioTemplate) while the CP is already Available
 * synchronously triggers CLIChargePointService's own "connect"-trigger
 * auto-start for manual, `triggerOn: "connect"` scenarios (the common/
 * default case — see `tryAutoStartForConnector`) — which is exactly the
 * case for every startup scenario once we've waited for boot acceptance
 * below. Calling `runScenario` unconditionally after `loadScenario`
 * would then throw "already running". Checking first keeps this
 * idempotent for both that auto-started case AND scenarios the
 * auto-start engine doesn't cover (non-"connect" triggers, disabled-then-
 * re-enabled, etc.), which still need this explicit call.
 */
function startScenarioIfNotAlreadyActive(
  svc: CLIChargePointService,
  connectorId: number,
  scenarioId: string,
): void {
  const alreadyActive = svc
    .listScenarios(connectorId)
    .some((s) => s.scenarioId === scenarioId && s.active);
  if (!alreadyActive) {
    svc.runScenario(connectorId, scenarioId);
  }
}

/** One connector's worth of what {@link installStartupScenario} loaded. */
export interface InstalledStartupScenario {
  readonly connectorId: number;
  readonly scenarioId: string;
}

/**
 * Load — and, under `--watch`, register — what the startup flags configure,
 * **without touching the network**.
 *
 * Split from starting it so the daemon can install *before* the charge point
 * dials. That ordering is the whole point, and it closes two windows at once:
 *
 * - **A restored definition must not run in the flag's place.** With
 *   `--state-db`, a charge point the flags configure comes back holding the
 *   previous boot's copy of that scenario, and the moment its boot gate opens
 *   the auto-start fires. Since #314 gave a generated instance a *stable* id,
 *   the flag's load and the restored copy are the same key — so a run started
 *   before the load leaves `startScenarioIfNotAlreadyActive` looking at an
 *   already-active id, and the stale graph keeps running while the current one
 *   never does. (While the ids differed, the flag's load installed a different
 *   key and the restored run was orphaned against a definition no longer
 *   installed, which is why this was recorded as tolerable — a judgement about
 *   the surrounding code that expired when that code changed.) Installing
 *   first means what auto-starts on the boot gate *is* the configured
 *   definition.
 * - **The captured copy must be reconciled before anything runs it.** The
 *   file is read once per boot, well before the restored fleet's connect;
 *   `registerScenarioFile` compares that copy against disk immediately, so an
 *   edit saved in the window is applied here — before the gate opens, with
 *   nothing in flight to defer it behind.
 *
 * Nothing here starts a run. `loadScenario`'s connect-auto-start is gated on
 * `chargePoint.status === Available`, which an undialled charge point is not,
 * so the installed definition sits inert until {@link startStartupScenario}
 * (for a `manual`-triggered scenario) or the boot gate's auto-start (for a
 * trigger-matching one) runs it.
 *
 * **Failure**: a per-connector failure is reported and the other connectors
 * still install; an unreadable file installs nothing and reports it.
 * **Provenance**: with a database, every row installed here is marked with
 * the flag that generated it ({@link startupProvenance}, #338), which is what
 * lets a later boot's {@link pruneStaleStartupScenarios} recognise it — except
 * a row that already existed user-authored under the same id, which stays so. Nothing
 * is removed here: the prune ran at restore, before anything dialled.
 * **Trigger**: called once per bootstrap charge point, before its dial.
 */
export function installStartupScenario(
  svc: CLIChargePointService,
  opt: NonNullable<ServerOptions["startupScenario"]>,
  connectorCount: number,
  /** Null unless the daemon runs with `--watch` (#314). */
  fileReload: FileReloadManager | null = null,
  /**
   * The `--state-db`, when there is one. Separate from `fileReload` because a
   * startup registration's effect on stored state is not conditional on the
   * watcher: taking over a key deletes whatever row was stored under it, and a
   * daemon started without `--watch` must still do that or a later watched
   * start would reattach the abandoned file (#314).
   */
  database: Database | null = null,
  /**
   * The boot's single read of the scenario file (#314). The daemon always
   * passes the same object it gave {@link startupClaimedScenarioIds}, so the
   * claim and the load describe the same bytes; the default is for direct
   * callers that have no claim to agree with, where this read *is* the load
   * and nothing can disagree with it.
   */
  source: StartupScenarioFile | null = readStartupScenarioFile(opt),
): InstalledStartupScenario[] {
  const installed: InstalledStartupScenario[] = [];
  // Which flag is in effect is asked once, through the same resolver
  // `startupClaimedScenarioIds` and `readStartupScenarioFile` read, so the load
  // and the prediction of it cannot pick different flags (#314).
  const mode = resolveStartupScenarioMode(opt);
  if (!mode) return installed;
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (connectors.length === 0) {
    process.stderr.write(
      `[server] No matching connectors for --scenario-connector "${opt.scenarioConnector}"\n`,
    );
    return installed;
  }

  // 1) Built-in template by id — instantiate per connector.
  if (mode.kind === "template") {
    for (const connectorId of connectors) {
      try {
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenarioTemplate(mode.templateId, connectorId),
        );
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario template "${mode.templateId}" loaded (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to load scenario template on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return installed;
  }

  // 2) Template JSON file — read once, instantiate per connector (cpId-independent).
  if (mode.kind === "templateFile") {
    if (!source?.definition || source.text === null) {
      process.stderr.write(
        `[server] Failed to read scenario template file: ${
          source?.error instanceof Error
            ? source.error.message
            : (source?.error ?? mode.path)
        }\n`,
      );
      return installed;
    }
    const template = source.definition;
    const templateText = source.text;
    warnOnScenarioSchemaMismatch(mode.path, template);
    for (const connectorId of connectors) {
      try {
        const instance = instantiateTemplate(template, connectorId);
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenario(connectorId, instance),
        );
        // #314: `prepare` replays the same per-connector rewrite on every
        // reload, so a fan-out across connectors keeps its independent copies
        // instead of collapsing onto the file's own targetId.
        fileReload?.registerScenarioFile({
          filePath: mode.path,
          cpId: svc.getInit().cpId,
          connectorId,
          scenarioId,
          prepare: (definition) => instantiateTemplate(definition, connectorId),
          loadedText: templateText,
          // Not persisted: a row cannot carry `prepare`, and this bootstrap
          // runs again on every boot and registers again. Persisting it left the next `--state-db` start with the previous
          // run's watches restored prepare-less, reloading the file's own
          // target over the prepared copies (#314).
          persist: false,
        });
        forgetWatchedScenarioFile(
          database,
          svc.getInit().cpId,
          connectorId,
          scenarioId,
        );
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario template file "${mode.path}" applied (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to apply template file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
    return installed;
  }

  // 3) Single scenario file — for fan-out, treat it like a template (rewrite
  // ids per connector); for single-connector, behave as before.
  if (mode.kind === "file") {
    if (!source?.definition || source.text === null) {
      process.stderr.write(
        `[server] Failed to read scenario file: ${
          source?.error instanceof Error
            ? source.error.message
            : (source?.error ?? mode.path)
        }\n`,
      );
      return installed;
    }
    const definition = source.definition;
    const scenarioText = source.text;
    warnOnScenarioSchemaMismatch(mode.path, definition);
    for (const connectorId of connectors) {
      try {
        // Re-evaluated per definition, not captured once (#314). A single
        // connector whose `--scenario` already targets it is loaded as-is; edit
        // `targetId` or `targetType` in that file and the answer changes, so a
        // `prepare` that remembered the first answer left the definition
        // registered on the original connector while its executor derived
        // expectations from the edited target — waiting on a connector it was
        // not attached to, and never firing.
        const prepare = (next: ScenarioDefinition): ScenarioDefinition =>
          scenarioFileTargetsConnector(next, connectorId, connectors.length)
            ? next
            : instantiateTemplate(next, connectorId);
        const scenarioId = loadWithStartupProvenance(
          database,
          svc.getInit().cpId,
          connectorId,
          startupProvenance(mode),
          () => svc.loadScenario(connectorId, prepare(definition)),
        );
        fileReload?.registerScenarioFile({
          filePath: mode.path,
          cpId: svc.getInit().cpId,
          connectorId,
          scenarioId,
          prepare,
          loadedText: scenarioText,
          // As above: `prepare` decides per reload whether the file already
          // targets this connector, and no persisted row can replay that.
          persist: false,
        });
        forgetWatchedScenarioFile(
          database,
          svc.getInit().cpId,
          connectorId,
          scenarioId,
        );
        installed.push({ connectorId, scenarioId });
        process.stderr.write(
          `[server] Scenario file "${mode.path}" loaded (id: ${scenarioId}, connector: ${connectorId})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[server] Failed to load scenario file on connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
  }
  return installed;
}

/**
 * Start what {@link installStartupScenario} loaded, once the boot gate is open.
 *
 * Wait (bounded) for each target connector's boot gate before firing anything.
 * `svc.connect()` only waits for the WebSocket to open, not for
 * `BootNotification.conf` — a scenario with no leading delay before its first
 * transaction node (e.g. cert16-tc005-ev-side-disconnect) can otherwise send
 * `StartTransaction` while the gate is still closed. The gate silently drops
 * gated outgoing CALLs sent before Accepted (see `OCPPMessageHandler
 * .sendRequest`'s `isCallAllowed` check), so the scenario would proceed with a
 * locally fabricated transactionId the CSMS never sees. See
 * `waitForBootAccepted()` for the full rationale and the timeout policy (30s
 * bound, warn-and-proceed).
 *
 * A scenario whose trigger matches has already been started by the boot gate's
 * own auto-start by the time this runs, so `startScenarioIfNotAlreadyActive`
 * is a no-op for it; a `manual`-triggered one is started only here, because
 * `tryAutoStartForConnector` deliberately skips those. Either way exactly one
 * run of the *installed* definition happens — which is the guarantee installing
 * before the dial buys, since whatever the gate auto-starts is now the
 * configured graph rather than a restored copy of the previous boot's (#314).
 */
export async function startStartupScenario(
  svc: CLIChargePointService,
  installed: readonly InstalledStartupScenario[],
): Promise<void> {
  if (installed.length === 0) return;
  const connectors = [...new Set(installed.map((one) => one.connectorId))];
  await Promise.all(
    connectors.map((connectorId) =>
      svc.waitForBootAccepted(connectorId, {
        onTimeout: () => {
          process.stderr.write(
            `[server] Warning: BootNotification not accepted within 30s for connector ${connectorId}; starting scenario anyway (its outgoing CALLs may be dropped by the boot gate until the CSMS accepts)\n`,
          );
        },
      }),
    ),
  );
  for (const { connectorId, scenarioId } of installed) {
    try {
      startScenarioIfNotAlreadyActive(svc, connectorId, scenarioId);
      process.stderr.write(
        `[server] Startup scenario started (id: ${scenarioId}, connector: ${connectorId})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[server] Failed to start startup scenario "${scenarioId}" on connector ${connectorId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }
}

/**
 * Install and then start, for callers that do both back to back.
 *
 * The daemon does **not** use this: it installs before the dial and starts
 * after, which is the ordering the split exists for. Kept because a caller with
 * nothing to interleave — a test, or any path where the charge point is already
 * connected — wants one call, and because the composition is the definition of
 * what the two halves add up to.
 */
export async function runStartupScenario(
  svc: CLIChargePointService,
  opt: NonNullable<ServerOptions["startupScenario"]>,
  connectorCount: number,
  fileReload: FileReloadManager | null = null,
  database: Database | null = null,
  source: StartupScenarioFile | null = readStartupScenarioFile(opt),
): Promise<void> {
  await startStartupScenario(
    svc,
    installStartupScenario(
      svc,
      opt,
      connectorCount,
      fileReload,
      database,
      source,
    ),
  );
}

/**
 * Which restored charge points must wait for the bootstrap loop to dial them.
 *
 * A charge point whose id a startup flag will claim has a restored copy of that
 * very scenario loaded, and it auto-starts the moment its boot gate opens.
 * Dialling it during the restore leaves the entire bootstrap loop — every other
 * charge point's connect, minutes against a slow CSMS — between that start and
 * the flag's load. Held back, the two happen one after the other in the same
 * iteration.
 *
 * Only when the bootstrap loop is actually going to dial (`--auto-connect`).
 * Without it nothing else would, and `runStartupScenario`'s
 * `waitForBootAccepted` would burn its full 30s timeout per connector on a
 * charge point that was deliberately left unconnected — the boot-accepted wait
 * broken by the very hold-back meant to protect it (#314).
 */
export function restoredDialsToDefer(
  restored: readonly string[],
  startupTargets: ReadonlySet<string>,
  autoConnect: boolean,
): Set<string> {
  if (!autoConnect) return new Set();
  return new Set(restored.filter((cpId) => startupTargets.has(cpId)));
}

/**
 * The first pass's row filter: hold back exactly the rows whose scenario id a
 * startup flag will overwrite on that charge point.
 *
 * Narrow on purpose, and the counterpart of {@link startupTargetCpIds}: widen
 * this to whole charge points and the *other* restored scenarios on them go
 * unwatched until they dial, which is the failure the first pass exists to
 * prevent. The two predicates answer different questions and neither one's
 * answer is safe for the other's job (#314).
 */
export function startupClaimedRowSkip(
  claimedByCp: ReadonlyMap<string, ReadonlySet<string>>,
): (row: { readonly cp_id: string; readonly scenario_id: string }) => boolean {
  return (row) => claimedByCp.get(row.cp_id)?.has(row.scenario_id) === true;
}

/**
 * Which charge points a startup flag is about to configure.
 *
 * Answers "is startup going to reconfigure this charge point?", which is a
 * different question from "which stored scenario ids will it overwrite?" — see
 * {@link startupClaimedScenarioIds} for that one. Every bootstrap charge point
 * is a target whenever any startup flag is set, because all three modes load a
 * definition onto every one of them; only the *ids* differ by mode, and ids are
 * irrelevant here.
 *
 * Keying the dial deferral on the id set instead let three of the four startup
 * modes through: `--scenario-template` and `--scenario-template-file` minted a
 * fresh id each boot and so claimed nothing, as did a `--scenario` that had to
 * be instantiated across connectors. Their restored charge points therefore
 * dialled immediately and their persisted `triggerOn: connect` scenarios
 * auto-started from the database, well before the configured definition
 * loaded (#314).
 *
 * Everything deferred here is dialled afterwards by the bootstrap loop, which
 * iterates exactly this fleet — see the mode table in `docs/entities/daemon.md`.
 */
export function startupTargetCpIds(
  startupScenario: ServerOptions["startupScenario"],
  fleet: readonly ChargePointInitOptions[],
): Set<string> {
  if (!isExplicitStartupScenario(startupScenario)) return new Set();
  return new Set(fleet.map((init) => init.cpId));
}

/** Whether any startup flag names something to load. */
export function isExplicitStartupScenario(
  startupScenario: ServerOptions["startupScenario"],
): boolean {
  return resolveStartupScenarioMode(startupScenario) !== null;
}

/**
 * Whether a `--scenario` definition already targets the connector it is being
 * loaded onto, and therefore keeps its own id instead of an instantiated one.
 *
 * Shared, not duplicated: `runStartupScenario` uses it to build the `prepare`
 * that runs on every reload, and the boot sequence uses it to work out which
 * persisted scenario ids the startup flags are about to claim. Those two
 * answers have to agree — a skip computed from a second copy of this rule would
 * drift from the load it is meant to predict (#314).
 */
export function scenarioFileTargetsConnector(
  definition: ScenarioDefinition,
  connectorId: number,
  connectorCount: number,
): boolean {
  return (
    connectorCount === 1 &&
    definition.targetType === "connector" &&
    definition.targetId === connectorId
  );
}

/**
 * The exact (connector, scenario id) pairs the startup flags will install on a
 * charge point with `connectorCount` connectors — or `null` when this boot
 * cannot tell.
 *
 * **Exact, not narrow.** Every startup-generated id is now stable —
 * {@link scenarioInstanceId}, derived from the file's or template's own id and
 * the connector — so every id the boot will load is knowable before it loads
 * anything, and this returns exactly that set. Two readers depend on it:
 *
 * - the watch restore's first pass skips these ids (through
 *   {@link startupClaimedScenarioIds}) and nothing else, or a charge point's
 *   *other* restored scenarios go unwatched until it dials (#314);
 * - {@link pruneStaleStartupScenarios} keeps these rows and removes every
 *   other startup-generated row, before anything dials (#338).
 *
 * **`null` is not empty.** An unreadable or unparsable file, a file without a
 * string `id`, or an unknown built-in template means the boot does not know
 * what its configuration calls for. The prune then removes nothing on the
 * charge points that configuration targets: the previous boot's instance stays
 * rather than an unreadable file wiping the scenario it configured last time.
 * No flag at all is the empty list: nothing is called for, so every
 * startup-generated row goes.
 *
 * Takes the boot's single read rather than opening the file itself: a
 * prediction with its own read is a prediction of a file that may not be the
 * one loaded, which is the bug this signature exists to make unrepresentable.
 */
export function startupClaimedInstances(
  opt: ServerOptions["startupScenario"],
  connectorCount: number,
  source: StartupScenarioFile | null,
): InstalledStartupScenario[] | null {
  // Resolved first, ahead of the `source` check, so a conflicting combination
  // is refused here too rather than answered with a set that happens to look
  // harmless. Asked through the same resolver the load reads, so the
  // prediction and the load cannot disagree about which flag is in effect.
  const mode = resolveStartupScenarioMode(opt);
  // A mode implies options, but only to a reader: narrowed for the compiler.
  if (!mode || !opt) return [];
  const connectors = resolveConnectorIds(opt.scenarioConnector, connectorCount);
  if (mode.kind === "template") {
    if (!getTemplateById(mode.templateId)) return null;
    // `loadScenarioTemplate` derives its id through the same function.
    return connectors.map((connectorId) => ({
      connectorId,
      scenarioId: scenarioInstanceId(mode.templateId, connectorId),
    }));
  }
  const definition = source?.definition;
  if (!definition || source.text === null) return null;
  const baseId = definition.id;
  if (typeof baseId !== "string") return null;
  // The same branch `installStartupScenario` takes, through the same
  // predicate — a second copy of the rule would drift from the load it
  // predicts. A template file always instantiates; a `--scenario` keeps its own
  // id only when it already targets its single connector.
  return connectors.map((connectorId) => ({
    connectorId,
    scenarioId:
      mode.kind === "file" &&
      scenarioFileTargetsConnector(definition, connectorId, connectors.length)
        ? baseId
        : scenarioInstanceId(baseId, connectorId),
  }));
}

/**
 * The persisted scenario ids the startup flags will claim on this boot: the
 * ids of {@link startupClaimedInstances}, and nothing when that is unknown.
 */
export function startupClaimedScenarioIds(
  opt: ServerOptions["startupScenario"],
  connectorCount: number,
  source: StartupScenarioFile | null,
): Set<string> {
  return new Set(
    (startupClaimedInstances(opt, connectorCount, source) ?? []).map(
      (one) => one.scenarioId,
    ),
  );
}

/**
 * What a startup flag records as the provenance of the rows it installs
 * (`scenarios.startup_source`, #338): the flag and its source — the resolved
 * file path, or the built-in template id. Informational: the prune only asks
 * whether a row has one.
 */
export function startupProvenance(mode: StartupScenarioMode): string {
  switch (mode.kind) {
    case "template":
      return `--scenario-template=${mode.templateId}`;
    case "templateFile":
      return `--scenario-template-file=${path.resolve(mode.path)}`;
    case "file":
      return `--scenario=${path.resolve(mode.path)}`;
  }
}

/**
 * **The** startup prune (#338): remove every startup-generated row on this
 * charge point that the boot's flags do not call for.
 *
 * A row is startup-generated when `scenarios.startup_source` is set; a NULL row
 * is user-authored and never touched. What the flags call for is
 * `claims.get(cpId)`, the exact set {@link startupClaimedInstances} predicts
 * and {@link installStartupScenario} then loads: a charge point the flags do
 * not configure (no flag, or not in the bootstrap fleet) keeps nothing marked,
 * and one whose claim is `null` (the boot cannot tell) is left as it is.
 *
 * A `legacy:<base>` row — a clock-suffixed id an older build generated, marked
 * by the v19 migration — is called for until the flags call for its stable
 * successor instead: it goes when this boot installs `<base>-c<connector>` or
 * `<base>` on the same connector, which is when the builds that minted it
 * removed it. One nothing replaces (a seeded default, a template loaded over
 * the control plane) stays, as it did.
 *
 * This one rule covers every way a previous boot's copy can outlive its
 * configuration: a `--scenario-connector` that no longer names a connector, a
 * file whose own `id` changed, a switched or dropped flag, a charge point that
 * left the fleet, and an older build's clock-suffixed copy of what this boot
 * installs. It replaces the two narrower prunes that preceded it — the
 * `-<epoch ms>` suffix match for `--scenario` and `loadScenarioTemplate`'s
 * per-template cleanup.
 *
 * **Ordering**: at restore, before the watch restore and before the charge
 * point dials, so a stale copy is never watched and never reaches the boot
 * gate's auto-start. **Destruction**: `removeScenario` discards any run and
 * deletes the row; a row whose id memory holds on another connector is
 * deleted directly. Its watch row goes too. **Failure**: a removal that throws
 * is reported and the next row is still processed.
 */
export function pruneStaleStartupScenarios(
  svc: CLIChargePointService,
  database: Database | null,
  claims: ReadonlyMap<string, readonly InstalledStartupScenario[] | null>,
): void {
  const cpId = svc.getInit().cpId;
  const claimed = claims.has(cpId) ? claims.get(cpId) : [];
  if (claimed === null || claimed === undefined) return;
  const keep = new Set(
    claimed.map((one) => `${one.connectorId}\u0000${one.scenarioId}`),
  );
  for (const row of listStartupScenarioRows(database, cpId)) {
    if (keep.has(`${row.connector_id}\u0000${row.scenario_id}`)) continue;
    if (row.startup_source.startsWith(LEGACY_STARTUP_SOURCE_PREFIX)) {
      const base = row.startup_source.slice(
        LEGACY_STARTUP_SOURCE_PREFIX.length,
      );
      const replaced = [base, scenarioInstanceId(base, row.connector_id)].some(
        (id) => keep.has(`${row.connector_id}\u0000${id}`),
      );
      if (!replaced) continue;
    }
    try {
      if (!svc.removeScenario(row.connector_id, row.scenario_id)) {
        deleteScenarioRow(database, cpId, row.connector_id, row.scenario_id);
      }
      forgetWatchedScenarioFile(
        database,
        cpId,
        row.connector_id,
        row.scenario_id,
      );
      process.stderr.write(
        `[server] Removed startup scenario "${row.scenario_id}" on ${cpId} connector ${row.connector_id}: generated by ${row.startup_source}; this boot does not call for it (#338)\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[server] Failed to remove stale startup scenario "${row.scenario_id}" on ${cpId} connector ${row.connector_id}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
  }
}

/**
 * Produce a connector-specific copy of a scenario definition by rewriting
 * targetType / targetId / id / name. Nodes and edges are deep-cloned so
 * multiple connectors can run independent state machines from one file.
 */
function instantiateTemplate(
  template: ScenarioDefinition,
  connectorId: number,
): ScenarioDefinition {
  const cloned = JSON.parse(JSON.stringify(template)) as ScenarioDefinition;
  return {
    ...cloned,
    id: scenarioInstanceId(cloned.id, connectorId),
    name: cloned.name
      ? `${cloned.name} (Connector ${connectorId})`
      : `Connector ${connectorId}`,
    targetType: "connector",
    targetId: connectorId,
  };
}
