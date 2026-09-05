import * as fs from "fs";
import * as path from "path";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import type { CPRegistry } from "./CPRegistry";
import type { Database } from "../../cp/domain/persistence/Database";
import { FileWatcher } from "./FileWatcher";
import {
  forgetWatchedConnectorScenarioFiles,
  forgetWatchedScenarioFile,
  listWatchedScenarioFiles,
  rememberWatchedScenarioFile,
  type WatchedScenarioFileRow,
} from "./watchedScenarioFiles";
import { parseIdTagsFile } from "./idTagFile";
import {
  ARRAY_MAX_ITEMS,
  SCENARIO_MAX_BYTES,
  STR_64K_MAX,
} from "../../protocol/limits";

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

interface ScenarioEntry extends ScenarioFileRegistration {
  readonly absolutePath: string;
  unwatch: () => void;
  /**
   * The last text this manager took responsibility for: applied, or held for a
   * session that will apply it. `null` means "no baseline to trust", so the
   * next read is judged on its merits rather than dismissed as unchanged.
   *
   * Three rules, one invariant. It is advanced only when the text was accepted
   * (`reloadScenario`), it is never advanced by a rejection, and it is cleared
   * when a held text is refused at drain time (`drainPending`) — because the
   * connector then keeps the older definition and a baseline claiming otherwise
   * makes the operator's next save of those exact bytes a silent no-op.
   */
  lastText: string | null;
  pending: ScenarioDefinition | null;
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
 * through {@link FileReloadManager.drainLater}, which is where the rule that a
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
    // One of the two drain triggers — see the note above `FileReloadManager`
    // for why no bus event can serve as either, and {@link drainLater} for why
    // both go through it. By the time this fires the executor is gone, or the
    // transaction is cleared, so a held definition actually lands.
    this.unsubscribeRunSettled = this.registry.onSessionSettled((cpId) => {
      if (this.scenarios.size === 0) return;
      this.drainLater(cpId);
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
          this.watcher.watch(absolute, () => this.reloadIdTags(absolute)),
        );
        this.idTagText.set(absolute, readTextOrEmpty(absolute));
      }
      // Per charge point, not per watch. `restoreFromDatabase` re-creates the
      // fleet one charge point at a time, each firing its own sync, so a second
      // charge point sharing an already-watched file would never be looked at.
      this.reconcileIdTags(absolute);
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
    // {@link drainLater}. Everything above this line stays synchronous on
    // purpose: it establishes watches and reconciles what is already loaded,
    // and delaying that would widen the read-then-watch window the ordering
    // above exists to close.
    this.drainLater(null);
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
      this.reloadScenario(key),
    );
    this.scenarios.set(key, entry);
    this.rememberScenarioFile(entry);
    // Close the rest of the window. Between the caller reading the file and the
    // watch starting, nothing is looking: a write in there produces no event,
    // and with the baseline holding the loaded text it would sit unnoticed
    // until the file changed again. One comparison now settles it — unchanged
    // bytes early-out, so the ordinary registration emits nothing.
    this.reloadScenario(key);
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

  /** Every live charge point whose `idTagPool.file` is this path. */
  private affectedByIdTagFile(absolutePath: string): string[] {
    return this.registry.list().filter((cpId) => {
      const file = this.registry.get(cpId)?.getInit().idTagFile;
      return file !== undefined && path.resolve(file) === absolutePath;
    });
  }

  private reloadIdTags(absolutePath: string): void {
    if (this.closed) return;
    const affected = this.affectedByIdTagFile(absolutePath);
    if (affected.length === 0) return;

    let text: string;
    try {
      text = fs.readFileSync(absolutePath, "utf-8");
    } catch (err) {
      this.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    // The directory watch fires for neighbours and for the editor's own extra
    // touches; identical bytes are not a reload and must not produce an event.
    if (this.idTagText.get(absolutePath) === text) return;

    let tags: string[];
    try {
      tags = parseIdTagsFile(absolutePath, text);
    } catch (err) {
      // Note: `lastText` is deliberately NOT updated. A file saved broken and
      // then saved again identically-broken should complain twice, and the next
      // good save must still be seen as a change.
      this.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    // Recorded only once the pool has actually been installed everywhere it
    // had to be. `applyIdTagReload` persists as well as mutates, so a transient
    // SQLITE_BUSY or a full disk throws *after* the live pool changed: caching
    // the text first left persisted state stale, emitted no outcome at all
    // (the throw reached the watcher's generic handler), and suppressed a retry
    // of the very same bytes. The baseline is a record of what landed.
    if (this.applyIdTags(affected, absolutePath, tags)) {
      this.idTagText.set(absolutePath, text);
    }
  }

  /**
   * Bring a newly watched file and the charge points behind it into agreement
   * (#314).
   *
   * A `--state-db` restore brings back the tags as they were when the daemon
   * last saw the file. Edit that file while the daemon is stopped and the
   * charge point comes back **stale** — and recording the file's current bytes
   * as the duplicate-suppression baseline would then suppress the operator's
   * next save of that same content as "not a change", leaving the pool stale
   * until the file happened to change again. So the comparison here is against
   * the tags the charge point actually holds, not against the bytes.
   *
   * Runs once per watch, from the branch that establishes it, so an unrelated
   * `cp.create` cannot re-report a file that has been broken on disk all along.
   */
  private reconcileIdTags(absolutePath: string): void {
    if (this.closed) return;
    const affected = this.affectedByIdTagFile(absolutePath).filter(
      (cpId) => !this.reconciledCps.has(reconcileKey(cpId, absolutePath)),
    );
    if (affected.length === 0) return;
    // Marked before anything can fail: a file that has been broken on disk all
    // along is reported once, not once per registry sync for the rest of the
    // daemon's life.
    for (const cpId of affected) {
      this.reconciledCps.add(reconcileKey(cpId, absolutePath));
    }
    const text =
      this.idTagText.get(absolutePath) ?? readTextOrEmpty(absolutePath);

    let tags: string[];
    try {
      tags = parseIdTagsFile(absolutePath, text);
    } catch (err) {
      // Same rule as the watch path: the baseline is dropped rather than left
      // pointing at bytes that never parsed, so the next save — good or bad —
      // is judged fresh instead of being written off as a duplicate.
      this.idTagText.delete(absolutePath);
      this.rejectAll(affected, "id-tags", absolutePath, err);
      return;
    }
    const stale = affected.filter(
      (cpId) => !sameTags(this.registry.get(cpId)?.getInit().idTags, tags),
    );
    if (stale.length === 0) return;
    this.log(
      `[watch] ${absolutePath} no longer matches ${stale.length} charge point(s) it was loaded into; reconciling`,
    );
    if (!this.applyIdTags(stale, absolutePath, tags)) {
      // Two caches here, and they follow opposite rules on purpose. The
      // `reconciledCps` marker above is set *before* the attempt: it exists so
      // a file that has been broken on disk all along is reported once rather
      // than at every registry sync. `idTagText` is a record of what actually
      // landed, so a failed apply must not leave the current bytes cached — the
      // operator's next save of that same content would be discarded as
      // unchanged and the database could never catch up. Do not "make these
      // consistent": they answer different questions.
      this.idTagText.delete(absolutePath);
    }
  }

  /** Whether every charge point took the new pool without throwing. A charge
   *  point that simply has no pool to replace is reported and counts as
   *  settled; a persistence failure does not. */
  private applyIdTags(
    cpIds: readonly string[],
    absolutePath: string,
    tags: readonly string[],
  ): boolean {
    let allSettled = true;
    for (const cpId of cpIds) {
      let applied: boolean;
      try {
        applied = this.registry.applyIdTagReload(cpId, tags);
      } catch (err) {
        // Persisting is part of applying: a pool that is live but not written
        // back comes apart at the next restart, so this is reported like any
        // other rejection rather than swallowed as a handler crash.
        allSettled = false;
        this.rejectAll([cpId], "id-tags", absolutePath, err);
        continue;
      }
      this.emit({
        target: "id-tags",
        path: absolutePath,
        cpId,
        connectorId: null,
        scenarioId: null,
        outcome: applied ? "applied" : "rejected",
        error: applied
          ? null
          : "charge point has no idTag pool to replace; recreate it with idTagPool set",
      });
      if (applied) {
        this.log(
          `[watch] ${cpId}: idTag pool reloaded from ${absolutePath} (${tags.length} tags)`,
        );
      }
    }
    return allSettled;
  }

  private reloadScenario(key: string): void {
    if (this.closed) return;
    const entry = this.scenarios.get(key);
    if (!entry) return;
    if (!this.registry.has(entry.cpId) || !this.stillLoaded(entry)) {
      entry.unwatch();
      this.scenarios.delete(key);
      this.forgetScenarioFile(entry.cpId, entry.connectorId, entry.scenarioId);
      return;
    }

    let text: string;
    try {
      text = fs.readFileSync(entry.absolutePath, "utf-8");
    } catch (err) {
      this.rejectScenario(entry, err);
      return;
    }
    if (entry.lastText === text) return;

    let definition: ScenarioDefinition;
    try {
      definition = this.parseScenario(entry, text);
    } catch (err) {
      this.rejectScenario(entry, err);
      return;
    }
    // Recorded only once the text has actually been accepted — applied, or held
    // for later. `loadScenario` can still refuse it, and a rejected save that
    // became the baseline would make the operator's next save of that same
    // content an early-out: no retry, no event, and the connector left on the
    // old definition until the bytes happened to change again. The idTag path
    // has always worked this way; these two must not disagree.
    if (this.applyOrDefer(entry, definition)) entry.lastText = text;
  }

  /**
   * Parse and normalise a reloaded scenario.
   *
   * The definition is forced back onto the id it was originally loaded under.
   * A file whose `id` was edited would otherwise load a *second* scenario and
   * leave the first one running under the old definition — the reverse of what
   * "reload" means, and unremovable through the connector's scenario list.
   *
   * The **target** follows one of two rules, and the difference is deliberate:
   *
   * - With a `prepare` — the startup flags — an edited `targetType` /
   *   `targetId` is *re-derived* on every reload. `--scenario` on a single
   *   connector that the file already targets is loaded as-is, and repointing
   *   the file has to be re-evaluated or the definition sits on the connector
   *   it was registered for while its executor waits on the new one.
   * - Without one — `load_scenario { file }` and `run_scenario_file` — the
   *   target is *pinned* to what was loaded. Nothing re-derives it there, so an
   *   edited target was accepted while the scenario stayed mapped to
   *   `entry.connectorId`: `ScenarioExecutor` then derived its expectations
   *   from the edited `targetId` and waited on a connector its runtime
   *   callbacks were not operating on. A reload replaces a definition; it never
   *   moves a scenario (#314).
   */
  private parseScenario(
    entry: ScenarioEntry,
    text: string,
  ): ScenarioDefinition {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The runtime's own message quotes the offending bytes — Node's reads
      // `Unexpected token 'o', "nope-secret-…" is not valid JSON`. That text
      // becomes the `error` field of a `file-reload` push and a stderr line, so
      // a half-saved scenario would put a fragment of its own contents on the
      // control plane. Say which file, never what is in it — the same rule
      // `parseIdTagsFile` already follows.
      throw new Error("file is not valid JSON");
    }
    if (!isScenarioShape(parsed)) {
      throw new Error("file does not contain a scenario definition");
    }
    const prepared = entry.prepare ? entry.prepare(parsed) : parsed;
    const result = validateScenarioSchema(prepared);
    if (!result.valid) {
      // Advisory at load time (#214), so advisory here too — the two paths must
      // accept the same files or `--watch` becomes a stricter second gate.
      this.log(
        `[watch] ${entry.absolutePath} does not match schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}`,
      );
    }
    if (entry.prepare) return { ...prepared, id: entry.scenarioId };
    // Pinned to the target the live definition carries — what the load
    // installed — rather than normalised to `entry.connectorId`, so a scenario
    // legitimately loaded against something other than its own connector keeps
    // that shape instead of being quietly rewritten by a reload.
    const live = this.registry
      .get(entry.cpId)
      ?.getScenario(entry.connectorId, entry.scenarioId);
    const pinned = { ...prepared, id: entry.scenarioId } as ScenarioDefinition &
      Record<string, unknown>;
    if (!live) {
      // No live definition to copy — only reachable if the scenario went away
      // between `stillLoaded` and here. Fall back to the registration, which is
      // the only target this manager can vouch for.
      pinned.targetType = "connector";
      pinned.targetId = entry.connectorId;
      return pinned;
    }
    pinned.targetType = live.targetType;
    // `undefined` is a value here, not a gap: a `chargePoint`-wide scenario has
    // no `targetId` on purpose, and filling it in from the registration made
    // the reload advertise connector-specific constraints for a definition that
    // deliberately had none — and persisted that. "Absent on purpose" and
    // "missing" are different, so the key is dropped rather than defaulted.
    if (live.targetId === undefined) delete pinned.targetId;
    else pinned.targetId = live.targetId;
    return pinned;
  }

  /** Whether the definition was accepted — applied now, or held for a session
   *  that has not ended yet. `false` means it was rejected outright and the
   *  connector still holds the previous definition. */
  private applyOrDefer(
    entry: ScenarioEntry,
    definition: ScenarioDefinition,
  ): boolean {
    const service = this.registry.get(entry.cpId);
    // Held, not dropped, in both of the cases below — `drainPending` has
    // already cleared `entry.pending`, so returning without restoring it is
    // exactly how a validated edit goes missing.
    if (!service) {
      entry.pending = definition;
      return true;
    }
    // The scenario is not on the connector right now. Either it was removed —
    // and `loadScenario` would cheerfully re-create it, which is the bug — or
    // this is the window inside a `cp.update` rebuild, where the old service
    // has been torn down and the snapshot is not yet re-attached. Never load,
    // and never unregister either: unregistering here would throw away the
    // watch and the held definition every time a charge point is edited.
    // `reloadScenario` drops a genuinely stale registration at the next edit.
    if (!this.stillLoaded(entry)) {
      entry.pending = definition;
      return true;
    }
    // Checked before anything is applied, because the alternative is the shape
    // this feature has been bitten by twice: the reload lands, is reported
    // `applied`, and then the push that tells every subscriber about it fails
    // envelope validation and is merely logged — leaving an editor drawing a
    // graph the daemon has stopped executing.
    //
    // What is validated is the *resulting snapshot*, not the edited definition.
    // `scenario-definitions-changed` carries every scenario on the connector, so
    // the edited file fitting `SCENARIO_MAX_BYTES` on its own proves nothing: an
    // oversized sibling, or a connector already holding more than
    // `ARRAY_MAX_ITEMS` scenarios, fails the same envelope through a different
    // door. Rejected here means the previous definition is still loaded and the
    // operator is told — the same contract a malformed file gets. Re-checked on
    // every apply rather than once at hold time, because a held edit drains
    // later and the siblings may have changed in between.
    const overflow = describeSnapshotOverflow(
      projectSnapshot(service, entry, definition),
      entry.scenarioId,
    );
    if (overflow) {
      this.rejectScenario(entry, new Error(overflow));
      return false;
    }
    if (
      service.hasOpenTransaction(entry.connectorId) ||
      service.isScenarioRunning(entry.scenarioId)
    ) {
      entry.pending = definition;
      this.emit({
        target: "scenario",
        path: entry.absolutePath,
        cpId: entry.cpId,
        connectorId: entry.connectorId,
        scenarioId: entry.scenarioId,
        outcome: "deferred",
        error: null,
      });
      this.log(
        `[watch] ${entry.cpId}/connector ${entry.connectorId}: scenario ${entry.scenarioId} reload held until the current session ends`,
      );
      return true;
    }
    try {
      service.loadScenario(entry.connectorId, definition);
    } catch (err) {
      this.rejectScenario(entry, err);
      return false;
    }
    entry.pending = null;
    this.emit({
      target: "scenario",
      path: entry.absolutePath,
      cpId: entry.cpId,
      connectorId: entry.connectorId,
      scenarioId: entry.scenarioId,
      outcome: "applied",
      error: null,
    });
    this.log(
      `[watch] ${entry.cpId}/connector ${entry.connectorId}: scenario ${entry.scenarioId} reloaded from ${entry.absolutePath}`,
    );
    // Last, and outside the try: the definition is live either way, and a
    // console that cannot be told must not be able to fail the reload.
    try {
      this.definitionsSink?.(
        entry.cpId,
        entry.connectorId,
        service
          .snapshotScenarios()
          .filter((loaded) => loaded.connectorId === entry.connectorId)
          .map((loaded) => loaded.definition),
      );
    } catch (err) {
      this.log(
        `[watch] scenario-definitions sink error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  /** Whether the charge point still holds the scenario this registration was
   *  made for. False once it has been removed. */
  private stillLoaded(entry: ScenarioEntry): boolean {
    return (
      this.registry
        .get(entry.cpId)
        ?.getScenario(entry.connectorId, entry.scenarioId) != null
    );
  }

  /** Retry every held definition, whatever charge point it belongs to. Used
   *  after a registry sync, where the charge point that was blocking a reload
   *  may have been rebuilt out from under it. */
  /**
   * Run a drain on a later microtask, never in the caller's stack.
   *
   * Both drain triggers go through here, because a drain does not merely read a
   * gate — it calls `loadScenario`, which can auto-start a run that snapshots
   * connector state. Doing that from inside the code that is mutating the
   * registry, or ending a session, is the defect this feature has now been
   * bitten by four times, and enumerating the callers that happen to be safe is
   * what failed the last three. So the requirement is expressed once, here:
   *
   * - `onSessionSettled` already announces on a microtask
   *   (`CLIChargePointService.notifySessionSettled`), so a settle drain was
   *   never in a teardown stack. It is routed through here anyway so that every
   *   drain in this file obeys one visible rule rather than two invisible ones.
   * - `onInitChange` is synchronous by contract and stays that way — its
   *   subscriber has to see the registry as the mutation left it, and the watch
   *   establishment it drives must not be delayed. `CPRegistry` pings it from
   *   `instantiate()`, the tail of `update()`, `remove()` and `shutdownAll()`;
   *   `remove()` is called in a loop by `resetAllState`, so a synchronous drain
   *   there could load and auto-start a scenario on a charge point the next
   *   iteration is about to tear down. `stillLoaded` covers the half-rebuilt
   *   window inside `update()` and `shutdownAll` cannot reach a drain at all
   *   (the lifecycle calls `close()` before it, and `closed` short-circuits the
   *   sync) — but "the sites I checked are safe" is exactly the reasoning that
   *   has been wrong here before.
   *
   * `closed` is re-checked when the microtask runs: the manager can be shut
   * down between scheduling and draining.
   */
  private drainLater(cpId: string | null): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      if (cpId === null) this.drainAllPending();
      else this.drainPending(cpId);
    });
  }

  private drainAllPending(): void {
    for (const cpId of new Set(
      [...this.scenarios.values()]
        .filter((entry) => entry.pending !== null)
        .map((entry) => entry.cpId),
    )) {
      this.drainPending(cpId);
    }
  }

  private drainPending(cpId: string): void {
    for (const entry of this.scenarios.values()) {
      if (entry.cpId !== cpId) continue;
      const pending = entry.pending;
      if (!pending) continue;
      // Re-checked, not assumed: the drain event may be one connector's
      // transaction ending while another's is still open.
      entry.pending = null;
      // `lastText` names the bytes this manager has taken responsibility for —
      // applied, or held for a session that will apply them. A drain that ends
      // in a rejection ends that responsibility without the bytes ever landing,
      // so the baseline goes with them. Left in place, the connector keeps the
      // older definition while the baseline claims the newer one, and the
      // operator re-saving those same valid bytes is discarded as unchanged:
      // their edit becomes unrecoverable without editing its content. The
      // direct path already advances the baseline only on success and a failed
      // idTag persist already clears its cache; this is the same rule reaching
      // the third of the three ways a reload can end (#314).
      if (!this.applyOrDefer(entry, pending)) entry.lastText = null;
    }
  }

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

  private rejectScenario(entry: ScenarioEntry, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`[watch] ${entry.absolutePath} was not reloaded: ${message}`);
    this.emit({
      target: "scenario",
      path: entry.absolutePath,
      cpId: entry.cpId,
      connectorId: entry.connectorId,
      scenarioId: entry.scenarioId,
      outcome: "rejected",
      error: message,
    });
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

/**
 * How much of a caller-supplied identifier a message may quote.
 *
 * A file-loaded definition gets only minimal shape validation, so its `id` is
 * whatever the file says — and one over 64 KiB embedded whole into a rejection
 * message pushed the envelope past its own bound, so the rejection was thrown
 * away and the subscriber saw nothing at all. Short enough to identify the
 * scenario, far short of anything that can overflow the field.
 */
const ID_IN_MESSAGE_MAX = 256;

/** Clamp a string to `max`, marking it when something was dropped. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `cpId` + absolute path. NUL cannot appear in either, so the split is exact. */
function reconcileKey(cpId: string, absolutePath: string): string {
  return `${cpId}\u0000${absolutePath}`;
}

function splitReconcileKey(key: string): [string, string] {
  const at = key.indexOf("\u0000");
  return [key.slice(0, at), key.slice(at + 1)];
}

function scenarioKey(
  cpId: string,
  connectorId: number,
  scenarioId: string,
): string {
  return `${cpId}\u0000${connectorId}\u0000${scenarioId}`;
}

/**
 * The definition list a `scenario-definitions-changed` push would carry if this
 * reload were applied: the connector's current scenarios with the reloaded one
 * swapped in under the id it was loaded under.
 *
 * Appends rather than assuming the id is present. `applyOrDefer` only gets here
 * once `stillLoaded` has passed, so the swap is the live case — but a snapshot
 * that silently dropped the incoming definition would under-count and let an
 * over-cap edit through, which is the failure this exists to catch.
 */
function projectSnapshot(
  service: {
    snapshotScenarios(): ReadonlyArray<{
      readonly connectorId: number;
      readonly definition: ScenarioDefinition;
    }>;
  },
  entry: ScenarioEntry,
  definition: ScenarioDefinition,
): ScenarioDefinition[] {
  let swapped = false;
  const projected = service
    .snapshotScenarios()
    .filter((loaded) => loaded.connectorId === entry.connectorId)
    .map((loaded) => {
      if (loaded.definition.id !== entry.scenarioId) return loaded.definition;
      swapped = true;
      return definition;
    });
  if (!swapped) projected.push(definition);
  return projected;
}

/**
 * Why the given snapshot could not be pushed, or `null` if it can.
 *
 * The two bounds are the envelope's own — `ARRAY_MAX_ITEMS` definitions, each
 * at most `SCENARIO_MAX_BYTES` serialized — read from `protocol/limits` rather
 * than restated, because a producer that hard-codes a bound is exactly how the
 * two drift. The message names the offending scenario id but never any of the
 * file's contents, the same rule `parseScenario` follows.
 */
function describeSnapshotOverflow(
  snapshot: readonly ScenarioDefinition[],
  reloadedId: string,
): string | null {
  if (snapshot.length > ARRAY_MAX_ITEMS) {
    return (
      `connector already holds ${snapshot.length} scenarios, over the ` +
      `${ARRAY_MAX_ITEMS} the control plane can carry in one update; ` +
      "the previous definition is still loaded"
    );
  }
  for (const definition of snapshot) {
    const size = JSON.stringify(definition).length;
    if (size <= SCENARIO_MAX_BYTES) continue;
    const which =
      definition.id === reloadedId
        ? "scenario"
        : `scenario "${truncate(definition.id, ID_IN_MESSAGE_MAX)}" on this connector`;
    return (
      `${which} is ${size} bytes, over the ${SCENARIO_MAX_BYTES}-byte limit ` +
      "the control plane can carry; the previous definition is still loaded"
    );
  }
  return null;
}

/** Order-sensitive: an idTag pool's order is its draw order under
 *  `round-robin`, so a reordered file is a real change. */
function sameTags(
  current: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  if (current === undefined || current.length !== next.length) return false;
  return current.every((tag, i) => tag === next[i]);
}

function readTextOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function isScenarioShape(value: unknown): value is ScenarioDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ScenarioDefinition>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}
