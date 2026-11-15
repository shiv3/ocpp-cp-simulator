import * as fs from "fs";

import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import {
  assertLoadableScenario,
  checkLoadableScenario,
} from "@ocpp-cp-simulator/core/scenario/loadableScenario";
import {
  ARRAY_MAX_ITEMS,
  SCENARIO_MAX_BYTES,
} from "@ocpp-cp-simulator/contracts/limits";
import type { CPRegistry } from "../CPRegistry";
import type {
  FileReloadEvent,
  ScenarioDefinitionsChangedSink,
  ScenarioFileRegistration,
} from "../FileReloadManager";
import { truncate } from "./shared";

export interface ScenarioEntry extends ScenarioFileRegistration {
  readonly absolutePath: string;
  unwatch: () => void;
  /**
   * The bytes this scenario **currently holds everywhere it has to hold them**.
   * `null` means "no baseline to trust", so the next read is judged on its
   * merits rather than dismissed as unchanged.
   *
   * The suppression this drives is why the wording keeps having to get
   * stronger: `reloadScenario` early-outs when the file still equals this, so
   * anything it claims falsely cancels a reload that was owed. Three review
   * rounds each found a different sense in which "landed" was untrue, so
   * "holds" is enumerated here rather than left to the next reader to
   * rediscover. It must be true:
   *
   * 1. **In memory** — the connector's runtime definition is these bytes.
   * 2. **For every consumer of the path**, not only the one being reconciled.
   *    The idTag half of this feature keys its baseline per *file* while charge
   *    points are reconciled one at a time; see `idTagText`.
   * 3. **Durably, when `--state-db` is on.** `loadScenario` installs
   *    synchronously and persists in the background, so a rejected write leaves
   *    memory and disk disagreeing. A baseline set on the strength of the
   *    in-memory half alone announced `applied` for a change a restart undoes,
   *    and then suppressed the operator's retry of the same bytes.
   *
   * What that leaves, stated as ordering and failure rather than as a list of
   * callers — the two things the audits that missed 2 and 3 did not say:
   *
   * - **Ordering.** A held edit claims the baseline when it is *accepted*, not
   *   when it is applied; between those two points it is a promise, and the
   *   drain that finally applies it re-decides. Nothing else may write here
   *   between them.
   * - **Failure.** Every way an accepted reload can still fail to hold — a
   *   parse that never happened, an apply refused at drain time, a durable
   *   write that rejects — clears this. `finishApply` is where the last of
   *   those lands, and it is the only place that learns of it.
   */
  lastText: string | null;
  pending: ScenarioDefinition | null;
}

/** What the scenario reload paths need from the manager that owns the state. */
export interface ScenarioReloadHost {
  readonly registry: CPRegistry;
  readonly scenarios: Map<string, ScenarioEntry>;
  isClosed(): boolean;
  definitionsSink(): ScenarioDefinitionsChangedSink | null;
  log(message: string): void;
  emit(event: FileReloadEvent): void;
  unregisterScenario(
    cpId: string,
    connectorId: number,
    scenarioId: string,
  ): void;
  forgetScenarioFile(
    cpId: string,
    connectorId: number,
    scenarioId: string,
  ): void;
}

export class ScenarioReload {
  constructor(private readonly host: ScenarioReloadHost) {}

  reloadScenario(key: string): void {
    if (this.host.isClosed()) return;
    const entry = this.host.scenarios.get(key);
    if (!entry) return;
    if (!this.host.registry.has(entry.cpId) || !this.stillLoaded(entry)) {
      entry.unwatch();
      this.host.scenarios.delete(key);
      this.host.forgetScenarioFile(
        entry.cpId,
        entry.connectorId,
        entry.scenarioId,
      );
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
    // The baseline is `applyOrDefer`'s to move: whether these bytes may claim it
    // depends on how the reload ends, and for an applied one that is not known
    // until the durable write settles.
    this.applyOrDefer(entry, definition, text);
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
      this.host.log(
        `[watch] ${entry.absolutePath} does not match packages/core/schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}`,
      );
    }
    // The same hard gate the initial load runs — `loadScenario` calls
    // `assertLoadableScenario` on every definition it accepts (#214's advisory
    // schema check is the other half, and stays advisory above). `isScenarioShape`
    // above only asks for `id`, `nodes` and `edges`, so a file that lost its
    // `name` in an edit passed it, was accepted for deferral, and had its bytes
    // cached as the baseline — and `loadScenario` then rejected it once the
    // session settled, with nothing left to re-apply because the baseline said
    // the charge points already held those bytes. Rejected here instead: an
    // unloadable file never becomes a held reload (#314). Since the browser
    // and the daemon share one gate, a *missing* `name` / `targetType` no
    // longer makes a file unloadable: the gate fills it in, and says so here
    // (the normalised copy is what reaches loadScenario, which then has
    // nothing left to report). A present but wrong one is still refused.
    const finalize = (definition: ScenarioDefinition): ScenarioDefinition =>
      assertLoadableScenario(definition, (message) =>
        this.host.log(`[watch] ${entry.absolutePath}: ${message}`),
      );
    if (entry.prepare) return finalize({ ...prepared, id: entry.scenarioId });
    // Pinned to the target the live definition carries — what the load
    // installed — rather than normalised to `entry.connectorId`, so a scenario
    // legitimately loaded against something other than its own connector keeps
    // that shape instead of being quietly rewritten by a reload.
    const live = this.host.registry
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
      return finalize(pinned);
    }
    pinned.targetType = live.targetType;
    // `undefined` is a value here, not a gap: a `chargePoint`-wide scenario has
    // no `targetId` on purpose, and filling it in from the registration made
    // the reload advertise connector-specific constraints for a definition that
    // deliberately had none — and persisted that. "Absent on purpose" and
    // "missing" are different, so the key is dropped rather than defaulted.
    if (live.targetId === undefined) delete pinned.targetId;
    else pinned.targetId = live.targetId;
    return finalize(pinned);
  }

  /** Whether the definition was accepted — applied now, or held for a session
   *  that has not ended yet. `false` means it was rejected outright and the
   *  connector still holds the previous definition. */
  private applyOrDefer(
    entry: ScenarioEntry,
    definition: ScenarioDefinition,
    /** The bytes `definition` was parsed from, or `null` when the caller has no
     *  text to make a baseline of. Owned here, because whether they may become
     *  the baseline is decided by the same outcomes this method reports. */
    text: string | null,
  ): boolean {
    const service = this.host.registry.get(entry.cpId);
    // Held, not dropped, in both of the cases below — `drainPending` has
    // already cleared `entry.pending`, so returning without restoring it is
    // exactly how a validated edit goes missing.
    //
    // And held bytes become the baseline, in **every** branch that holds, not
    // just the session gate further down. `lastText` names the bytes this
    // manager has taken responsibility for, and holding is taking
    // responsibility; a hold that skipped it would leave the drain recording
    // the *previous* bytes as the baseline for the definition it just applied,
    // so re-saving those previous bytes would early-out as unchanged and the
    // connector would keep running the edit the operator had undone.
    //
    // Stated as inert rather than oversold, because it is: `reloadScenario`
    // answers both of these questions *before* it reads the file, so neither
    // branch is reachable with fresh text today, and the only other caller
    // (`drainPending`) passes `entry.lastText` itself, which makes the write a
    // no-op. This is the invariant being maintained uniformly so that the next
    // caller of `applyOrDefer` inherits it, not a live bug being closed (#314).
    if (!service) {
      entry.pending = definition;
      if (text !== null) entry.lastText = text;
      return true;
    }
    // Asked *before* the hold below, and that order is the fix rather than an
    // accident. The connector this reload is registered for no longer exists —
    // `remove_connector`, or a `cp.update` that rebuilt the charge point with
    // fewer connectors. Nothing can apply the definition to it and nothing will
    // ever release a hold taken for it, so treating this as the rebuild window
    // meant holding forever. Checking it second is exactly what stranded a
    // shrinking `cp.update`: the hold below fired first and the question was
    // never reached (#314).
    if (!service.hasConnector(entry.connectorId)) {
      this.rejectScenario(
        entry,
        new Error(
          `connector ${entry.connectorId} was removed; the file is no longer watched`,
        ),
      );
      this.host.unregisterScenario(
        entry.cpId,
        entry.connectorId,
        entry.scenarioId,
      );
      return false;
    }
    // The connector is there but the scenario is not on it right now. Either it
    // was removed — and `loadScenario` would cheerfully re-create it, which is
    // the bug — or this is the window inside a `cp.update` rebuild, where the
    // old service has been torn down and the snapshot is not yet re-attached.
    // Never load, and never unregister either: unregistering here would throw
    // away the watch and the held definition every time a charge point is
    // edited. `reloadScenario` drops a genuinely stale registration at the next
    // edit.
    if (!this.stillLoaded(entry)) {
      entry.pending = definition;
      // Held, so the same baseline rule as every other hold — see the branch
      // above.
      if (text !== null) entry.lastText = text;
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
    // ---- the deferral gate -------------------------------------------------
    //
    // A reload is held while the connector is mid-session or the scenario's own
    // run is in flight. The contract this has to keep is one sentence: **an
    // accepted reload always ends in `applied` or `rejected` — never neither.**
    // A gate is only safe if every way it can close is paired with a way it
    // reopens *and* with something that looks again, so all of it is enumerated
    // here — the same discipline `ScenarioEntry.lastText` needed, for the same
    // reason.
    //
    // **Ordering.** The condition is re-read at drain time, never cached: a
    // drain may be one connector's session ending while another's is still
    // open. Every drain runs on a later microtask (`drainLater`), so it never
    // executes inside the teardown that opened the gate.
    //
    // **What reopens it.** A real stop, via `transactionChange(null)` — emitted
    // *after* the field is nulled. A run settling, via `runScenario`'s cleanup
    // or `resetScenario`. A `cp.update` rebuild, via `syncFromRegistry`'s
    // drain. And a connector being removed, via the settle announced from
    // `connectorRemoved` — which lands on the branch above, not here.
    //
    // **What never closes it.** A stopped transaction object still attached to
    // the connector: `cleanTransaction` stamps `stopTime` without detaching it,
    // and a `connector_runtime` snapshot persisted before #491 (when a
    // CALLERROR start stayed attached) restores one. No `transactionChange(null)`
    // follows — so a gate keyed on "an object is attached" would close with
    // nothing able to reopen it.
    // `hasOpenTransaction` therefore asks whether a session is *running*, which
    // is the definition the rest of the codebase already uses.
    //
    // **Destruction.** The two things a hold waits on can be destroyed rather
    // than released: the connector (above — including a `cp.update` that
    // rebuilds with fewer of them) and the charge point (pruned by
    // `syncFromRegistry`, which forgets the row with it). Shutdown closes the
    // manager and drops every hold with it.
    //
    // **Trigger.** The dimension that cost three rounds, because it is not the
    // same question as any of the above: a gate that *reads* open still needs
    // something to *re-read* it. Enumerating when the condition clears found
    // every one of those clearings and still left holds stranded, because the
    // clearing and the notification are separate events and one can happen
    // without the other — `cleanTransaction` opens the gate and announces
    // nothing. So the guarantee does not rest on the precise triggers at all:
    // `CLIChargePointService` announces a settle on **every connector status
    // transition**, which no lifecycle change on a live connector avoids. The
    // precise triggers remain because they make the drain prompt; the backstop
    // is what makes the contract true rather than nearly true.
    if (
      service.hasOpenTransaction(entry.connectorId) ||
      service.isScenarioRunning(entry.scenarioId)
    ) {
      entry.pending = definition;
      this.host.emit({
        target: "scenario",
        path: entry.absolutePath,
        cpId: entry.cpId,
        connectorId: entry.connectorId,
        scenarioId: entry.scenarioId,
        outcome: "deferred",
        error: null,
      });
      this.host.log(
        `[watch] ${entry.cpId}/connector ${entry.connectorId}: scenario ${entry.scenarioId} reload held until the current session ends`,
      );
      // Held bytes become the baseline: they have been accepted, and the drain
      // that installs them later re-decides whether they may keep it. The same
      // line stands in the two hold branches above — this is the rule for
      // *holding*, not a property of this particular gate, and having it in
      // only one of the three places is what let a drain record stale bytes.
      if (text !== null) entry.lastText = text;
      return true;
    }
    try {
      // `applied` and the baseline are both claims about durable state, so
      // neither is made until the write settles. `loadScenario` installs the
      // definition synchronously and persists in the background, swallowing a
      // rejected write — so reporting on its return announced a change that a
      // restart undoes, and then suppressed the operator's retry of the very
      // same bytes as a duplicate (#314).
      service.loadScenario(entry.connectorId, definition, {
        onPersisted: (error) => this.finishApply(entry, text, error),
      });
    } catch (err) {
      this.rejectScenario(entry, err);
      return false;
    }
    entry.pending = null;
    // Last, and outside the try: the definition is live either way, and a
    // console that cannot be told must not be able to fail the reload.
    try {
      this.host.definitionsSink()?.(
        entry.cpId,
        entry.connectorId,
        service
          .snapshotScenarios()
          .filter((loaded) => loaded.connectorId === entry.connectorId)
          .map((loaded) => loaded.definition),
      );
    } catch (err) {
      this.host.log(
        `[watch] scenario-definitions sink error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  /**
   * Report a reload once its durable write has settled.
   *
   * On success the definition is live *and* durable, so `applied` is announced
   * and the bytes become the baseline. On failure it is live but not durable —
   * a restart brings back the previous definition — so `rejected` is announced
   * and the baseline is cleared, which is what lets the operator's next save of
   * the same content be judged rather than dismissed.
   *
   * The in-memory definition is deliberately **not** rolled back. Rolling back
   * means loading the previous definition again, which can tear down a run the
   * reload has already auto-started — trading a durability failure for a
   * liveness one, and adding a second write that can fail the same way. What is
   * reported is therefore precise about which half failed, rather than pretending
   * nothing happened.
   */
  private finishApply(
    entry: ScenarioEntry,
    text: string | null,
    error: unknown | null,
  ): void {
    if (this.host.isClosed()) return;
    if (error) {
      entry.lastText = null;
      const message = error instanceof Error ? error.message : String(error);
      this.host.log(
        `[watch] ${entry.cpId}/connector ${entry.connectorId}: scenario ${entry.scenarioId} reloaded into memory but could not be stored: ${message}`,
      );
      this.host.emit({
        target: "scenario",
        path: entry.absolutePath,
        cpId: entry.cpId,
        connectorId: entry.connectorId,
        scenarioId: entry.scenarioId,
        outcome: "rejected",
        error: `scenario could not be stored: ${message}; it is live until the daemon restarts`,
      });
      return;
    }
    if (text !== null) entry.lastText = text;
    this.host.emit({
      target: "scenario",
      path: entry.absolutePath,
      cpId: entry.cpId,
      connectorId: entry.connectorId,
      scenarioId: entry.scenarioId,
      outcome: "applied",
      error: null,
    });
    this.host.log(
      `[watch] ${entry.cpId}/connector ${entry.connectorId}: scenario ${entry.scenarioId} reloaded from ${entry.absolutePath}`,
    );
  }

  /** Whether the charge point still holds the scenario this registration was
   *  made for. False once it has been removed. */
  private stillLoaded(entry: ScenarioEntry): boolean {
    return (
      this.host.registry
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
  drainLater(cpId: string | null): void {
    if (this.host.isClosed()) return;
    queueMicrotask(() => {
      if (this.host.isClosed()) return;
      if (cpId === null) this.drainAllPending();
      else this.drainPending(cpId);
    });
  }

  private drainAllPending(): void {
    for (const cpId of new Set(
      [...this.host.scenarios.values()]
        .filter((entry) => entry.pending !== null)
        .map((entry) => entry.cpId),
    )) {
      this.drainPending(cpId);
    }
  }

  private drainPending(cpId: string): void {
    for (const entry of this.host.scenarios.values()) {
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
      // The held bytes are already the baseline. A drain that ends in a
      // rejection — a sibling grew past the envelope cap, or the write failed —
      // takes it back with it, so the same edit saved again is judged afresh.
      const held = entry.lastText;
      if (!this.applyOrDefer(entry, pending, held)) entry.lastText = null;
    }
  }

  private rejectScenario(entry: ScenarioEntry, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.host.log(`[watch] ${entry.absolutePath} was not reloaded: ${message}`);
    this.host.emit({
      target: "scenario",
      path: entry.absolutePath,
      cpId: entry.cpId,
      connectorId: entry.connectorId,
      scenarioId: entry.scenarioId,
      outcome: "rejected",
      error: message,
    });
  }
}

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

/** The structural half of the load gate (`checkLoadableScenario`): an object
 *  with a non-empty string `id` and `nodes` / `edges` arrays. */
function isScenarioShape(value: unknown): value is ScenarioDefinition {
  return checkLoadableScenario(value).errors.length === 0;
}
