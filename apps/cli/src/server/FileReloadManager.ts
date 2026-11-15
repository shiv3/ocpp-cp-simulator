import * as path from "path";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { CPRegistry } from "./CPRegistry";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { FileWatcher } from "./FileWatcher";
import {
  forgetWatchedConnectorScenarioFiles,
  forgetWatchedScenarioFile,
  listWatchedScenarioFiles,
  rememberWatchedScenarioFile,
  type WatchedScenarioFileRow,
} from "./watchedScenarioFiles";
import { STR_64K_MAX } from "@ocpp-cp-simulator/contracts/limits";
import { IdTagReload, splitReconcileKey } from "./reload/idTagReload";
import { ScenarioReload, type ScenarioEntry } from "./reload/scenarioReload";
import { readTextOrEmpty, truncate } from "./reload/shared";

/** What kind of file was reloaded. */
export type FileReloadTarget = "id-tags" | "scenario";

/**
 * What the reload did.
 *
 * - `applied` — the new copy is live.
 * - `deferred` — the file parsed, but the charge point is mid-session; the new
 *   copy is held and installed when the session ends.
 * - `rejected` — the file could not be read or did not parse; the previous good
 *   copy is untouched.
 */
export type FileReloadOutcome = "applied" | "deferred" | "rejected";

export interface FileReloadEvent {
  readonly target: FileReloadTarget;
  readonly path: string;
  readonly cpId: string;
  readonly connectorId: number | null;
  readonly scenarioId: string | null;
  readonly outcome: FileReloadOutcome;
  readonly error: string | null;
}

export type FileReloadSink = (event: FileReloadEvent) => void;

/**
 * "This connector's scenario definitions changed" (#314).
 *
 * A reload updates the runtime and the persisted definition, but the
 * `file-reload` envelope goes to the `file-reload` scope. A console that
 * subscribed through `subscribeScenarioDefinitions` listens on
 * `scenario-definitions` and would go on displaying the old graph while the
 * daemon executed the new one, so the standard update is pushed as well.
 *
 * The definitions come from the connector's *runtime* set rather than from the
 * scenario repository, deliberately: the repository is empty on a daemon
 * running without `--state-db`, and `loadScenario` persists in the background,
 * so reading it back would push either nothing or the graph that was just
 * replaced. What an editor needs to show is what the daemon is executing.
 */
export type ScenarioDefinitionsChangedSink = (
  cpId: string,
  connectorId: number,
  definitions: readonly ScenarioDefinition[],
) => void;

export interface ScenarioFileRegistration {
  readonly filePath: string;
  readonly cpId: string;
  readonly connectorId: number;
  /** The id the definition was loaded under. A reload replaces this scenario,
   *  it never loads a second one alongside it. */
  readonly scenarioId: string;
  /** Applied to the freshly-parsed definition before it is loaded — how the
   *  startup fan-out rewrites a template per connector. Identity by default. */
  readonly prepare?: (definition: ScenarioDefinition) => ScenarioDefinition;
  /**
   * The exact text the caller loaded, when it still has it.
   *
   * The duplicate-suppression baseline has to be the bytes the live definition
   * came from, not whatever is on disk by the time this registration runs — a
   * write between the caller's read and this call would otherwise be recorded
   * as already-seen and never applied at all (#314).
   *
   * Explicitly `null` means "there is no baseline to trust": the definition did
   * not come from a read of this file at all — a `--state-db` restore rebuilt
   * it from the database — so whatever is on disk now must be applied rather
   * than adopted as already-seen.
   */
  readonly loadedText?: string | null;
  /**
   * Whether this registration is durable — recorded in `watched_scenario_files`
   * so a `--state-db` restart re-establishes the watch. Defaults to `true`.
   *
   * `false` for the startup flags (`--scenario`, `--scenario-template-file`).
   * They re-register themselves on every boot, and only they know how to: the
   * per-connector rewrite lives in a `prepare` callback that no row can carry.
   * A persisted startup registration is therefore restored *without* it, so the
   * next boot would reload the raw file's own `targetId` over the prepared
   * instance — and, for a template fanned out across connectors, would do it
   * under the previous run's scenario ids, leaving a stale watch per connector
   * alongside the fresh one (#314). Not persisting is the whole fix: the
   * bootstrap is the only thing that can restore these, and it always runs.
   */
  readonly persist?: boolean;
}

/**
 * Why there is no bus-event drain here.
 *
 * Every lifecycle event this daemon publishes announces the end of something
 * from inside the code that is ending it, while the state it announces is still
 * set. `scenario_completed` fires from the executor's state hook with the
 * executor still in `_executors`. `transaction_stopped` and the `Finishing`
 * status fire from `ChargePoint.stopTransaction` several statements before
 * `connector.stopTransaction()` clears the transaction. A drain keyed on any of
 * them therefore re-checks a gate that is still shut, defers again, and waits
 * for a notification that never comes — three separate stranded-reload bugs in
 * this feature had exactly that shape, and a `connector_status` backstop only
 * hid which of them were real.
 *
 * `CPRegistry.onSessionSettled` replaces the lot. It fires from the points
 * where the two gate conditions actually clear — `runScenario`'s cleanup, the
 * connector's `transactionChange` to null, and `resetScenario`'s setter-based
 * drop — and always after they have cleared.
 *
 * It is not the only drain trigger, though it is the only *gate-opening* one.
 * `syncFromRegistry` drains as well, because a `cp.update` rebuilds the charge
 * point and takes the old service's lifecycle handlers with it, so nothing else
 * would retry a definition held against the CP that no longer exists. Both go
 * through {@link ScenarioReload.drainLater}, which is where the rule that a
 * drain never runs in its caller's stack is written down.
 */

/**
 * Re-reads the files the daemon loaded, when it was started with `--watch`
 * (#314).
 *
 * Two rules are the contract, and both are here rather than at the call sites
 * so they cannot be implemented differently twice:
 *
 * - **A malformed file never lands.** Read, parse and validate first; only a
 *   file that would have been accepted at load time replaces the live copy.
 *   Everything else is logged, reported as `rejected`, and leaves the previous
 *   good copy exactly where it was.
 * - **A reload never mutates a charge point mid-session.** A scenario reload
 *   for a connector with an open transaction, or for a scenario whose run is in
 *   flight, is *held* — not dropped — and installed when the session ends. An
 *   idTag pool is exempt by construction: it is drawn from once per session, so
 *   the transaction under way keeps the tag it started with.
 */
export class FileReloadManager {
  private readonly watcher: FileWatcher;
  private readonly idTagWatches = new Map<string, () => void>();
  /**
   * Per watched idTag file: the bytes **every charge point backed by that path
   * currently holds**.
   *
   * Not "the bytes of the last reload that landed" — that weaker reading is
   * what made a narrower advance look correct. The map is the watch path's
   * duplicate-suppression baseline, and `reloadIdTags` early-outs when the file
   * still matches it, so anything it claims on behalf of charge points that do
   * not hold those bytes cancels a reload those charge points still need. The
   * window is real on a healthy watcher: a file changes, the debounced re-read
   * is scheduled, and a charge point created inside that window reads disk
   * itself and is already current — advancing the path-wide baseline on the
   * strength of that one made the pending callback exit as unchanged and left
   * every earlier charge point on the old tags indefinitely (#314).
   *
   * So it advances only when every consumer of the path agrees, and is dropped
   * outright when a parse or an apply fails.
   *
   * **Partial failure across a set is not the same as failure**, and a boolean
   * cannot express it — the fifth distinct sense in which "these bytes landed"
   * has been untrue here, after memory, every consumer of the path, durability,
   * and the branches that merely *held* a definition. `applyIdTags` loops over
   * every charge point sharing the file, so an earlier one can be changed —
   * live pool and persisted row both — before a later one throws. The audit
   * that cleared this half checked one iteration, where "the daemon is
   * untouched and its `rejected` is true of everything" genuinely holds; it does
   * not hold of the loop. Its single `false` therefore means *somewhere between
   * none and all of them changed*, which is precisely when the baseline must
   * claim nothing. Every write to this map on a reload path goes through
   * {@link recordIdTagOutcome} so that one sentence has one implementation.
   */
  private readonly idTagText = new Map<string, string>();
  /**
   * Charge points already checked against the file they were loaded from, keyed
   * by charge point **and absolute path**.
   *
   * Once per charge point, not once per file — several restored charge points
   * can share one pool and arrive one at a time. And once per *source*: a
   * `cp.update` that swaps `idTagPool.file` deletes and re-adds the charge
   * point without an intervening sync, so an id-only key filtered the new path
   * out as "already reconciled" and let its bytes become the baseline unapplied.
   */
  private readonly reconciledCps = new Set<string>();
  private readonly database: Database | null;
  private readonly scenarios = new Map<string, ScenarioEntry>();
  private sink: FileReloadSink | null = null;
  private definitionsSink: ScenarioDefinitionsChangedSink | null = null;
  private unsubscribeRunSettled: (() => void) | null = null;
  private closed = false;
  private readonly log: (message: string) => void;
  private readonly idTags: IdTagReload;
  private readonly scenarioReload: ScenarioReload;

  constructor(
    private readonly registry: CPRegistry,
    options: {
      readonly watcher?: FileWatcher;
      readonly log?: (message: string) => void;
      /** The daemon's `--state-db`, when it has one. Scenario registrations are
       *  written here so a restart re-establishes their watches (#314). */
      readonly database?: Database | null;
    } = {},
  ) {
    this.database = options.database ?? null;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.watcher = options.watcher ?? new FileWatcher({ log: this.log });
    // Collaborators read the manager's state through these accessors, so a
    // reassigned field (`closed`, `definitionsSink`) is passed as a function
    // and public calls (`unregisterScenario`) still go through this object.
    this.idTags = new IdTagReload({
      registry: this.registry,
      idTagText: this.idTagText,
      reconciledCps: this.reconciledCps,
      isClosed: () => this.closed,
      log: (message) => this.log(message),
      emit: (event) => this.emit(event),
      rejectAll: (cpIds, target, filePath, err) =>
        this.rejectAll(cpIds, target, filePath, err),
    });
    this.scenarioReload = new ScenarioReload({
      registry: this.registry,
      scenarios: this.scenarios,
      isClosed: () => this.closed,
      definitionsSink: () => this.definitionsSink,
      log: (message) => this.log(message),
      emit: (event) => this.emit(event),
      unregisterScenario: (cpId, connectorId, scenarioId) =>
        this.unregisterScenario(cpId, connectorId, scenarioId),
      forgetScenarioFile: (cpId, connectorId, scenarioId) =>
        this.forgetScenarioFile(cpId, connectorId, scenarioId),
    });
    // One of the two drain triggers — see the note above `FileReloadManager`
    // for why no bus event can serve as either, and {@link ScenarioReload.drainLater} for why
    // both go through it. By the time this fires the executor is gone, or the
    // transaction is cleared, so a held definition actually lands.
    this.unsubscribeRunSettled = this.registry.onSessionSettled((cpId) => {
      if (this.scenarios.size === 0) return;
      this.scenarioReload.drainLater(cpId);
    });
  }

  /** Where reload events go on the control plane. Set after the socket.io
   *  bridge exists, which is later than this object has to be constructed. */
  setSink(sink: FileReloadSink | null): void {
    this.sink = sink;
  }

  /** Where "this connector's definitions changed" goes after a scenario
   *  reload. Wired alongside {@link setSink}, once the socket.io bridge and
   *  the facade that can list the definitions both exist. */
  setScenarioDefinitionsSink(
    sink: ScenarioDefinitionsChangedSink | null,
  ): void {
    this.definitionsSink = sink;
  }

  /** Whether `fs.watch` failed at least once and reloads are inert. */
  get degraded(): boolean {
    return this.watcher.degraded;
  }

  watchedPaths(): string[] {
    return this.watcher.watchedPaths();
  }

  /**
   * Bring the set of watched idTag files in line with the registry.
   *
   * Driven off `CPRegistry.onInitChange` rather than off the create path, so
   * `cp.create`, `cp.create_many`, `cp.update` and a `--state-db` restore all
   * reach it without each having to remember to. Idempotent.
   */
  syncFromRegistry(): void {
    if (this.closed) return;
    const wanted = new Set<string>();
    for (const cpId of this.registry.list()) {
      const file = this.registry.get(cpId)?.getInit().idTagFile;
      if (file) wanted.add(path.resolve(file));
    }
    for (const [watched, unwatch] of [...this.idTagWatches]) {
      if (wanted.has(watched)) continue;
      unwatch();
      this.idTagWatches.delete(watched);
      this.idTagText.delete(watched);
    }
    for (const absolute of wanted) {
      if (!this.idTagWatches.has(absolute)) {
        // Watch established *before* the baseline is read, deliberately. Read
        // first and a save landing in between produces no event — nothing is
        // looking yet — while the cached text is already the pre-edit copy, so
        // the reconcile below compares the old file against the pool it came
        // from, finds them equal, and leaves the charge point stale until some
        // unrelated later event. This is the window `registerScenarioFile`
        // closes on the scenario path; the two are the only two watch sites.
        this.idTagWatches.set(
          absolute,
          this.watcher.watch(absolute, () =>
            this.idTags.reloadIdTags(absolute),
          ),
        );
        this.idTagText.set(absolute, readTextOrEmpty(absolute));
      }
      // Per charge point, not per watch. `restoreFromDatabase` re-creates the
      // fleet one charge point at a time, each firing its own sync, so a second
      // charge point sharing an already-watched file would never be looked at.
      this.idTags.reconcileIdTags(absolute);
    }
    // A charge point that is gone takes its scenario registrations with it, and
    // stops being one this reloader has reconciled — recreating it under the
    // same id is a new charge point and gets looked at again.
    for (const [key, entry] of [...this.scenarios]) {
      if (this.registry.has(entry.cpId)) continue;
      entry.unwatch();
      this.scenarios.delete(key);
      this.forgetScenarioFile(entry.cpId, entry.connectorId, entry.scenarioId);
    }
    for (const key of [...this.reconciledCps]) {
      const [cpId, watched] = splitReconcileKey(key);
      // Dropped when the charge point is gone, and when it no longer draws from
      // that file — a `cp.update` that repoints `idTagPool.file` has to be
      // looked at again, not remembered as done.
      if (!this.registry.has(cpId) || !wanted.has(watched)) {
        this.reconciledCps.delete(key);
      }
    }
    // A `cp.update` tears the charge point down and builds a replacement. That
    // ends whatever session was holding a reload back, but the old service's
    // lifecycle handlers went with it, so nothing else would ever retry.
    //
    // Deferred, not called here: `onInitChange` fires synchronously from inside
    // `instantiate`, `update`, `remove` and `shutdownAll`, so a drain run at
    // this point would start work from inside a registry mutation — see
    // {@link ScenarioReload.drainLater}. Everything above this line stays synchronous on
    // purpose: it establishes watches and reconciles what is already loaded,
    // and delaying that would widen the read-then-watch window the ordering
    // above exists to close.
    this.scenarioReload.drainLater(null);
  }

  /**
   * Watch the file a scenario was loaded from.
   *
   * Registering the same (cpId, connector, scenarioId) twice replaces the
   * earlier registration — re-running `load_scenario` with a different file is
   * an operator changing their mind, not a second thing to watch.
   */
  registerScenarioFile(registration: ScenarioFileRegistration): void {
    if (this.closed) return;
    const absolutePath = path.resolve(registration.filePath);
    const key = scenarioKey(
      registration.cpId,
      registration.connectorId,
      registration.scenarioId,
    );
    this.scenarios.get(key)?.unwatch();
    const entry: ScenarioEntry = {
      ...registration,
      absolutePath,
      unwatch: () => {},
      lastText:
        registration.loadedText === null
          ? null
          : (registration.loadedText ?? readTextOrEmpty(absolutePath)) || null,
      pending: null,
    };
    entry.unwatch = this.watcher.watch(absolutePath, () =>
      this.scenarioReload.reloadScenario(key),
    );
    this.scenarios.set(key, entry);
    this.rememberScenarioFile(entry);
    // Close the rest of the window. Between the caller reading the file and the
    // watch starting, nothing is looking: a write in there produces no event,
    // and with the baseline holding the loaded text it would sit unnoticed
    // until the file changed again. One comparison now settles it — unchanged
    // bytes early-out, so the ordinary registration emits nothing.
    this.scenarioReload.reloadScenario(key);
  }

  /**
   * Stop watching the file behind a scenario that is no longer file-backed.
   *
   * Called when a scenario is removed, and when one is replaced by an inline
   * definition under the same id. Without it the file stays authoritative: the
   * next edit would re-create a scenario the operator deleted, or overwrite the
   * inline definition they just installed. {@link applyOrDefer} refuses to
   * resurrect a removed scenario in any case — removal paths that never reach
   * the control plane exist — but this drops the watch at once rather than at
   * the next edit.
   */
  unregisterScenario(
    cpId: string,
    connectorId: number,
    scenarioId: string,
  ): void {
    const key = scenarioKey(cpId, connectorId, scenarioId);
    const entry = this.scenarios.get(key);
    // Forgotten even when nothing is registered in memory: after a restart the
    // row can outlive the registration it came from, and a scenario the
    // operator removed must not come back as a watch at the next restart.
    this.forgetScenarioFile(cpId, connectorId, scenarioId);
    if (!entry) return;
    entry.unwatch();
    this.scenarios.delete(key);
  }

  /**
   * Stop watching every file-backed scenario on one connector (#314).
   *
   * `scenario.definitions.replace` swaps a connector's whole definition set for
   * one uploaded from the console, which makes the console the source of truth
   * for that connector. Any file still watched behind one of those ids would
   * otherwise overwrite the upload at its next edit — the same defect an inline
   * `load_scenario` had, through a second door.
   */
  unregisterConnectorScenarios(cpId: string, connectorId: number): void {
    for (const [key, entry] of [...this.scenarios]) {
      if (entry.cpId !== cpId || entry.connectorId !== connectorId) continue;
      entry.unwatch();
      this.scenarios.delete(key);
    }
    forgetWatchedConnectorScenarioFiles(this.database, cpId, connectorId);
  }

  /**
   * Re-establish the watches a previous run of this daemon registered (#314).
   *
   * Called once, after `restoreFromDatabase` has rebuilt the fleet and its
   * scenarios. Only control-plane loads are here: `--scenario` and
   * `--scenario-template-file` re-register by themselves, because the bootstrap
   * runs again on every start. A row whose scenario is no longer loaded — the
   * operator removed it, or `--state-db` was pointed elsewhere — is dropped
   * rather than re-watched.
   */
  restoreScenarioWatches(
    opts: {
      /** Rows to leave for a later pass — see the caller for why. */
      readonly skip?: (row: WatchedScenarioFileRow) => boolean;
    } = {},
  ): void {
    if (this.closed || !this.database) return;
    const rows = listWatchedScenarioFiles(this.database);
    for (const row of rows) {
      // A row records what a *previous* run knew. It must never overwrite what
      // this run has already been told, and by the time this executes the
      // daemon has been accepting RPCs for a while: the HTTP listener opens
      // before the bootstrap begins, so a `run_scenario_file` arriving while
      // the fleet was still connecting has already written its own row and
      // registered a live watch under this key. Replacing that registration
      // would hand it `loadedText: null`, whose immediate reconcile defers the
      // definition that is running and can auto-start it a second time once the
      // first run settles — duplicate traffic out of one request (#314).
      if (
        this.scenarios.has(
          scenarioKey(row.cp_id, row.connector_id, row.scenario_id),
        )
      ) {
        continue;
      }
      // Held back for the second pass: a startup flag is about to claim this
      // exact scenario id, and a stored row under it names a file the operator
      // has replaced. Applying it here would reconcile the abandoned graph onto
      // the connector and — with a matching trigger — start it, after which the
      // flag's load replaces only the definition and finds an executor already
      // running. Skipped now, restored after the bootstrap, by which time the
      // flag has taken its key and deleted its row. Neither prune nor register:
      // an untouched row is exactly what the second pass needs to see.
      //
      // The predicate is deliberately narrow. Skipping a whole charge point
      // instead left its *other* restored scenarios unwatched right up to the
      // moment it dialled, so they auto-started from the database copy rather
      // than from the file as it reads now — constraint 1 broken by
      // constraint 2's own solution (#314).
      if (opts.skip?.(row)) continue;
      const loaded = this.registry
        .get(row.cp_id)
        ?.getScenario(row.connector_id, row.scenario_id);
      if (!loaded) {
        this.forgetScenarioFile(row.cp_id, row.connector_id, row.scenario_id);
        continue;
      }
      // `loadedText: null` — no baseline to trust. The definition came back
      // from the database, not from a read of this file, so seeding the
      // baseline from disk would adopt an edit made while the daemon was down
      // as already-seen. Registering with no baseline makes the reconcile that
      // follows apply it, which is the guarantee the idTag half already gives.
      this.registerScenarioFile({
        filePath: row.path,
        cpId: row.cp_id,
        connectorId: row.connector_id,
        scenarioId: row.scenario_id,
        loadedText: null,
      });
    }
  }

  private rememberScenarioFile(entry: ScenarioEntry): void {
    if (entry.persist === false) {
      // Taking over a key is a removal of whatever owned it before. A startup
      // registration writes no row of its own, but the same
      // (cpId, connectorId, scenarioId) may already carry one from a
      // control-plane load in an earlier run. Left behind, the next restart
      // restores that abandoned file, applies it *before* the bootstrap
      // registers the configured scenario, and — if its trigger matches — can
      // auto-start the stale graph and keep the real one from running (#314).
      this.forgetScenarioFile(entry.cpId, entry.connectorId, entry.scenarioId);
      return;
    }
    rememberWatchedScenarioFile(
      this.database,
      entry.cpId,
      entry.connectorId,
      entry.scenarioId,
      entry.absolutePath,
    );
  }

  private forgetScenarioFile(
    cpId: string,
    connectorId: number,
    scenarioId: string,
  ): void {
    forgetWatchedScenarioFile(this.database, cpId, connectorId, scenarioId);
  }

  close(): void {
    this.closed = true;
    this.definitionsSink = null;
    this.unsubscribeRunSettled?.();
    this.unsubscribeRunSettled = null;
    this.watcher.close();
    this.idTagWatches.clear();
    this.idTagText.clear();
    this.reconciledCps.clear();
    this.scenarios.clear();
  }

  // -- reload paths ---------------------------------------------------------

  // -- reporting ------------------------------------------------------------

  private rejectAll(
    cpIds: readonly string[],
    target: FileReloadTarget,
    filePath: string,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`[watch] ${filePath} was not reloaded: ${message}`);
    for (const cpId of cpIds) {
      this.emit({
        target,
        path: filePath,
        cpId,
        connectorId: null,
        scenarioId: null,
        outcome: "rejected",
        error: message,
      });
    }
  }

  private emit(event: FileReloadEvent): void {
    try {
      // Clamped here, at the last point before the envelope, as well as where
      // each message is composed. Composing carefully is what makes the text
      // readable; clamping here is what makes the guarantee hold — an event
      // that fails envelope validation is swallowed by the bridge, so an
      // unbounded string anywhere in this object turns a correct rejection into
      // silence. Three separate bugs in this feature have been exactly that
      // (#314), so the bound is enforced on the object rather than trusted to
      // every caller that builds one.
      this.sink?.({
        ...event,
        path: truncate(event.path, ENVELOPE_STR_MAX),
        error:
          event.error === null ? null : truncate(event.error, ENVELOPE_STR_MAX),
      });
    } catch (err) {
      this.log(
        `[watch] event sink error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The `file-reload` envelope's cap on `path` and `error` (`STR_64K`).
 *
 * Read here rather than restated, so the producer and the schema that rejects
 * it cannot drift — the same discipline `ARRAY_MAX_ITEMS` follows on the
 * definitions envelope.
 */
const ENVELOPE_STR_MAX = STR_64K_MAX;

function scenarioKey(
  cpId: string,
  connectorId: number,
  scenarioId: string,
): string {
  return `${cpId}\u0000${connectorId}\u0000${scenarioId}`;
}
