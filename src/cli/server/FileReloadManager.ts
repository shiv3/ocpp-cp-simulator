import * as fs from "fs";
import * as path from "path";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import { FileWatcher } from "./FileWatcher";
import { parseIdTagsFile } from "./idTagFile";

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
}

interface ScenarioEntry extends ScenarioFileRegistration {
  readonly absolutePath: string;
  unwatch: () => void;
  lastText: string | null;
  pending: ScenarioDefinition | null;
}

/**
 * Bus events after which a deferred reload is worth retrying.
 *
 * `transaction_stopped` is the one the mid-session rule is written around, and
 * `connector_status` is a cheap backstop for the paths that end a session
 * without it (a hard reset, a disconnect mid-charge). Draining re-evaluates the
 * gate, so an extra attempt is never an early one.
 *
 * The scenario-run terminators are deliberately **not** here.
 * `scenario_completed` and `scenario_error` are emitted from the executor's own
 * state hooks — synchronously, while the executor is still registered and
 * `isScenarioRunning` still answers `true`. Draining on them re-deferred every
 * reload held behind a run and then waited for a further event that a run
 * ending normally never produces, so the held definition was silently dropped.
 * `CPRegistry.onScenarioRunSettled` (fired after the run's cleanup) is the
 * authoritative terminator instead.
 */
const DRAIN_EVENTS = new Set(["transaction_stopped", "connector_status"]);

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
  private readonly scenarios = new Map<string, ScenarioEntry>();
  private sink: FileReloadSink | null = null;
  private unsubscribeBus: (() => void) | null = null;
  private unsubscribeRunSettled: (() => void) | null = null;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(
    private readonly registry: CPRegistry,
    bus: EventBus,
    options: {
      readonly watcher?: FileWatcher;
      readonly log?: (message: string) => void;
    } = {},
  ) {
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.watcher = options.watcher ?? new FileWatcher({ log: this.log });
    this.unsubscribeBus = bus.subscribe("*", (env) => {
      // Cheapest possible early-out: this sink sees every charge point event.
      if (this.scenarios.size === 0) return;
      if (!DRAIN_EVENTS.has(env.evt.event)) return;
      this.drainPending(env.cpId);
    });
    // The other half of the drain, and the load-bearing one for a scenario that
    // simply runs to its end: by the time this fires the executor is gone, so
    // the held definition actually lands instead of being deferred a second
    // time and forgotten.
    this.unsubscribeRunSettled = this.registry.onScenarioRunSettled((cpId) => {
      if (this.scenarios.size === 0) return;
      this.drainPending(cpId);
    });
  }

  /** Where reload events go on the control plane. Set after the socket.io
   *  bridge exists, which is later than this object has to be constructed. */
  setSink(sink: FileReloadSink | null): void {
    this.sink = sink;
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
      if (this.idTagWatches.has(absolute)) continue;
      this.idTagText.set(absolute, readTextOrEmpty(absolute));
      this.idTagWatches.set(
        absolute,
        this.watcher.watch(absolute, () => this.reloadIdTags(absolute)),
      );
      // Once per watch, never on a later sync for an unrelated charge point.
      this.reconcileIdTags(absolute);
    }
    // A charge point that is gone takes its scenario registrations with it.
    for (const [key, entry] of [...this.scenarios]) {
      if (this.registry.has(entry.cpId)) continue;
      entry.unwatch();
      this.scenarios.delete(key);
    }
    // A `cp.update` tears the charge point down and builds a replacement. That
    // ends whatever session was holding a reload back, but the old service's
    // lifecycle handlers went with it, so nothing else would ever retry.
    this.drainAllPending();
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
      lastText: readTextOrEmpty(absolutePath) || null,
      pending: null,
    };
    entry.unwatch = this.watcher.watch(absolutePath, () =>
      this.reloadScenario(key),
    );
    this.scenarios.set(key, entry);
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
  }

  close(): void {
    this.closed = true;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.unsubscribeRunSettled?.();
    this.unsubscribeRunSettled = null;
    this.watcher.close();
    this.idTagWatches.clear();
    this.idTagText.clear();
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
    this.idTagText.set(absolutePath, text);
    this.applyIdTags(affected, absolutePath, tags);
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
    const text = this.idTagText.get(absolutePath);
    if (text === undefined) return;
    const affected = this.affectedByIdTagFile(absolutePath);
    if (affected.length === 0) return;

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
    this.applyIdTags(stale, absolutePath, tags);
  }

  private applyIdTags(
    cpIds: readonly string[],
    absolutePath: string,
    tags: readonly string[],
  ): void {
    for (const cpId of cpIds) {
      const applied = this.registry.applyIdTagReload(cpId, tags);
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
  }

  private reloadScenario(key: string): void {
    if (this.closed) return;
    const entry = this.scenarios.get(key);
    if (!entry) return;
    if (!this.registry.has(entry.cpId) || !this.stillLoaded(entry)) {
      entry.unwatch();
      this.scenarios.delete(key);
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
    entry.lastText = text;
    this.applyOrDefer(entry, definition);
  }

  /**
   * Parse and normalise a reloaded scenario.
   *
   * The definition is forced back onto the id it was originally loaded under.
   * A file whose `id` was edited would otherwise load a *second* scenario and
   * leave the first one running under the old definition — the reverse of what
   * "reload" means, and unremovable through the connector's scenario list.
   */
  private parseScenario(
    entry: ScenarioEntry,
    text: string,
  ): ScenarioDefinition {
    const parsed: unknown = JSON.parse(text);
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
    return { ...prepared, id: entry.scenarioId };
  }

  private applyOrDefer(
    entry: ScenarioEntry,
    definition: ScenarioDefinition,
  ): void {
    const service = this.registry.get(entry.cpId);
    // Held, not dropped, in both of the cases below — `drainPending` has
    // already cleared `entry.pending`, so returning without restoring it is
    // exactly how a validated edit goes missing.
    if (!service) {
      entry.pending = definition;
      return;
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
      return;
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
      return;
    }
    try {
      service.loadScenario(entry.connectorId, definition);
    } catch (err) {
      this.rejectScenario(entry, err);
      return;
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
      this.applyOrDefer(entry, pending);
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
      this.sink?.(event);
    } catch (err) {
      this.log(
        `[watch] event sink error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function scenarioKey(
  cpId: string,
  connectorId: number,
  scenarioId: string,
): string {
  return `${cpId} ${connectorId} ${scenarioId}`;
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
