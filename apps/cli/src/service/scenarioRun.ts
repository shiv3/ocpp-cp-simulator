import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import type { ScenarioEvents } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { createScenarioExecutorCallbacks } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRuntime";
import { EventEmitter } from "@ocpp-cp-simulator/core/cp/shared/EventEmitter";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRepository";
import { type ScenarioPositionSnapshot } from "@ocpp-cp-simulator/core/cp/domain/persistence/ConnectorRuntimeRepository";
import type { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import { makeScenarioRunId } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import { redactSensitiveText } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import type {
  CLIEvent,
  SessionSettledHandler,
  SessionSettledInfo,
} from "./cliEvents";
import type { CLIChargePointService } from "../service";

/** What the scenario run / stop / wait functions need from `CLIChargePointService`. */
export interface ScenarioRunHost extends Pick<
  CLIChargePointService,
  "stopScenario" | "getScenarioRunResult"
> {
  readonly chargePoint: ChargePoint;
  readonly scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  >;
  readonly executors: Map<string, ScenarioExecutor>;
  readonly runIdByScenario: Map<string, string>;
  readonly armedWaitersByScenario: Map<string, Array<() => void>>;
  readonly scenarioPositionByConnector: Map<number, ScenarioPositionSnapshot>;
  readonly pendingScenarioResumes: Map<number, ScenarioPositionSnapshot>;
  readonly executorConnectorIds: Map<string, number>;
  readonly evSettingsOwnerByConnector: Map<number, string>;
  readonly lastRunStatusByScenario: Map<string, ScenarioExecutionContext>;
  readonly sessionSettledHandlers: Set<SessionSettledHandler>;
  readonly recorder: ScenarioRunRecorder;
  readonly runs: ScenarioRunRepository;
  emit(evt: CLIEvent): void;
  persistConnectorRuntime(
    connector: ReturnType<ChargePoint["connectors"]["get"]>,
    connectorId: number,
  ): void;
}

/**
 * Whether a run that is ending should release the connector's EV settings
 * override.
 *
 * The override is a single boolean on the connector. For three rounds this
 * function tried to reconstruct *whose* boolean it is from the state around it
 * — is a definition with `evSettings` installed (presence), is the installed
 * definition mine (identity), does the replacement declare `evSettings`
 * (declaration) — and each reconstruction was right only for the cases someone
 * had thought of. So the override now has an owner: the run id that actually
 * applied it, recorded by `CLIChargePointService` at the moment
 * `applyEvSettingsOverride` returns (the `onEvSettingsApplied` hook), and the
 * question is one comparison.
 *
 * The three clauses fall out of it rather than being enumerated in the code:
 *
 * 1. **Release only what this run set (#105).** A run that never declared
 *    `evSettings` never claimed, so the owner is not it — an explicit
 *    `set_ev_settings` an operator applied to the connector survives. So does
 *    an operator set made *during* the run, because that clears the owner
 *    (see `setEVSettings`): the last claim wins, and it is not this run's.
 * 2. **Do not release what someone else claimed since (#314).** A replacement
 *    run that has applied its own `evSettings` owns the override; clearing
 *    would unmark a live one.
 * 3. **Do release on ordinary completion (#314).** Nothing but a later claim
 *    or an operator set overwrites the owner, so on a normal finish it is
 *    still this run's — including when the scenario was removed outright,
 *    where nobody claimed anything.
 *
 * **Ordering, which is what every earlier formulation got wrong:** a
 * replacement definition is *installed before it runs, and may never run at
 * all*. `_scenarios` therefore answers "what is installed", never "what has
 * taken effect", and the two are different points in time. The owner is
 * written only by a claim, so it answers the second question and cannot be
 * fooled by the first. `_scenarios` also never reflects the *end* of a run —
 * nothing removes the entry on completion — which is the other half of the
 * same confusion.
 *
 * A run id is unique per invocation (`makeScenarioRunId`), so this never
 * mistakes a later run of the same scenario for the one that is ending. An
 * absent id — `null`, or the `""` the stop path falls back to when
 * `_runIdByScenario` no longer holds one — means "no run" and matches nothing;
 * a real owner is always a `makeScenarioRunId` string, so the two can never
 * meet in the middle.
 */
export function shouldReleaseEvSettingsOverride(
  endingRunId: string | null,
  ownerRunId: string | null,
): boolean {
  if (!endingRunId || !ownerRunId) return false;
  return endingRunId === ownerRunId;
}

/**
 * Whether the connector's stored scenario position belongs to `scenarioId`.
 *
 * The third field on this branch to need an owner, and by design *not* a third
 * bespoke rule: the EV settings override got a run id
 * (`shouldReleaseEvSettingsOverride`), the executor slot compares references,
 * and this entry has carried its owner all along in `scenarioKey`. So the
 * cleanup asks the same question the other two ask — "is the thing I am about
 * to clear still mine?" — rather than assuming it.
 *
 * An absent entry is vacuously mine: there is nothing to take from anyone.
 */
export function scenarioPositionIsOwnedBy(
  held: ScenarioPositionSnapshot | undefined,
  scenarioId: string,
): boolean {
  if (!held) return true;
  return held.scenarioKey === scenarioId;
}

/**
 * Clear the connector's scenario position, but only if it is `scenarioId`'s.
 *
 * The third field on this branch to need an owner, and the third time the
 * question is the same one: the EV settings override got a run id
 * (`_evSettingsOwnerByConnector`), the executor slot compares references,
 * and this entry has carried its owner all along — `scenarioKey` is written
 * by whichever run acquired the position. So this is that comparison, not a
 * fourth bespoke rule.
 *
 * **Ordering** is why it is needed. The position is per *connector*, the
 * cleanup is per *run*, and a run's `finally` is a queued microtask: between
 * a run stopping and its `finally`, `resetScenario` returns the connector to
 * Available and that can synchronously auto-start another scenario, which
 * acquires the position and may already have written a checkpoint. The old
 * run's unconditional `delete` then threw away the new run's position, and
 * with `--state-db` the next boot replayed nodes the new run had completed.
 * `_executors` cannot answer this: it is keyed by scenarioId, so a *different*
 * scenario starting on the same connector leaves the outgoing id's slot
 * empty and the guard reading "nobody owns this".
 */
/**
 * Whether this connector's checkpoint belongs to a *different* run that is
 * still going.
 *
 * The acquisition half of the ownership rule (#314). Three cases, and only
 * the middle one is a preserve:
 *
 * - **Same key** — a finished earlier run of this same scenario id; a live
 *   one is refused by `runScenario`'s "already running" check before this is
 *   reached. Clear: it is this id's own stale position.
 * - **Another key, still in `_executors`** — a run in flight on this
 *   connector. Preserve: it is still writing that position, and a restart
 *   must resume *it*, not read its node ids as though they were this run's.
 * - **Another key, not running** — dead, or stopped with its `finally` still
 *   queued. Clear, which is the case the acquisition clear was written for:
 *   left behind, a restart before this run's first node resumed the new graph
 *   from the old graph's node ids.
 *
 * `_executors` is the authority for "still going": the stop paths delete from
 * it synchronously, so a run stopped a moment ago does not keep holding a
 * checkpoint the incoming run should own.
 */
export function scenarioPositionHeldByOtherLiveRun(
  host: ScenarioRunHost,
  connectorId: number,
  incomingScenarioId: string,
): boolean {
  const held = host.scenarioPositionByConnector.get(connectorId);
  if (!held) return false;
  if (held.scenarioKey === incomingScenarioId) return false;
  return host.executors.has(held.scenarioKey);
}

export function clearScenarioPositionIfOwned(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): void {
  const held = host.scenarioPositionByConnector.get(connectorId);
  if (!scenarioPositionIsOwnedBy(held, scenarioId)) return;
  host.scenarioPositionByConnector.delete(connectorId);
}

export function runScenario(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
  options?: { strict?: boolean },
): void {
  const entry = host.scenarios.get(scenarioId);
  if (!entry) {
    throw new Error(`Scenario ${scenarioId} not found`);
  }
  if (entry.connectorId !== connectorId) {
    throw new Error(
      `Scenario ${scenarioId} is not loaded for connector ${connectorId}`,
    );
  }
  if (host.executors.has(scenarioId)) {
    throw new Error(`Scenario ${scenarioId} is already running`);
  }

  const connector = host.chargePoint.connectors.get(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  // #179: mint a stable run id for this invocation, threaded into every
  // lifecycle event (and echoed on scenario_status) so a headless runner can
  // correlate a specific run.
  const runId = makeScenarioRunId(scenarioId, Date.now(), Math.random());
  host.runIdByScenario.set(scenarioId, runId);

  // #179 Phase 2b/3: capture the OCPP wire transcript for this run so its
  // declared assertions (if any) can be evaluated once it ends, and
  // snapshot the connector for the report's `initialState`.
  host.recorder.begin(scenarioId, connector, { strict: options?.strict });

  // Set by the onError hook below; read in executor.start().finally() to
  // decide this run's verdict executionState ("error" vs "completed").
  let hadError = false;
  // #179 Phase 3: error message(s) seen during this run, redacted, for
  // the report's `errors` field.
  const errorMessages: string[] = [];

  const callbacks = createScenarioExecutorCallbacks({
    chargePoint: host.chargePoint,
    connector,
    hooks: {
      onStateChange: (context) => {
        if (context.state === "completed") {
          host.emit({
            event: "scenario_completed",
            data: { connectorId, scenarioId, runId },
          });
        }
        // Resolve any pending waitForScenarioArmed() caller once the run
        // either parks on its first expectation ("waiting" — e.g. a
        // RemoteStartTransaction trigger has armed) or ends without ever
        // parking ("completed"/"error", or "idle" via a manual stop). A
        // caller that opted in (run_scenario's awaitArmed) is unblocked
        // the instant the scenario is actually listening, closing the
        // race with a CSMS command sent right after run_scenario returns.
        if (
          context.state === "waiting" ||
          context.state === "completed" ||
          context.state === "error" ||
          context.state === "idle"
        ) {
          resolveScenarioArmedWaiters(host, scenarioId);
        }
      },
      onNodeExecute: (nodeId) => {
        host.emit({
          event: "scenario_node_execute",
          data: { connectorId, scenarioId, nodeId, runId },
        });
      },
      onWaitIntervention: (intervention) => {
        host.recorder.recordIntervention(scenarioId, connectorId, intervention);
        host.emit({
          event: "scenario_wait_changed",
          data: {
            connectorId,
            scenarioId,
            runId,
            nodeId: intervention.nodeId,
            kind: intervention.kind,
          },
        });
      },
      onError: (error) => {
        hadError = true;
        errorMessages.push(redactSensitiveText(error.message));
        host.emit({
          event: "scenario_error",
          data: { connectorId, scenarioId, error: error.message, runId },
        });
      },
      // #314: this run has applied EV settings to the connector, so it owns
      // the override until someone else claims it. The claim, not the
      // declaration — a definition declaring `evSettings` that is installed
      // but never runs never gets here, which is the whole point.
      onEvSettingsApplied: () => {
        host.evSettingsOwnerByConnector.set(connectorId, runId);
      },
    },
  });

  // Build a per-executor event emitter so we can subscribe to
  // `node.complete` and persist the scenario position after every
  // step. Without this, a daemon restart mid-flow can resume the
  // connector_runtime row (Charging, in-flight transaction) but the
  // scenario would replay from `start` and double-fire side-effecting
  // nodes (Plug In, Start Transaction) before reaching `meterValue`.
  const eventEmitter = new EventEmitter<ScenarioEvents>();
  eventEmitter.on("node.complete", (data: ScenarioEvents["node.complete"]) => {
    // Push the latest position into the connector-keyed map so any
    // imminent connector-field-change write (status/transaction/…)
    // picks it up. Then trigger a write directly so a daemon kill
    // *right now* still captures the just-finished node.
    // Accumulated onto **this run's** trail only. The connector's slot can
    // hold a neighbouring run's checkpoint — a run that starts beside one
    // already in flight preserves it rather than clearing it (#314) — and
    // appending to that produced a row mixing two graphs' node ids under
    // the incoming run's `scenarioKey`. The structural resume check then
    // found foreign ids in `executedNodes`, rejected the position, and
    // replayed this scenario from its start node, re-firing every
    // side-effecting node it had already run. Ownership changes here, so
    // the trail restarts here.
    const existing = host.scenarioPositionByConnector.get(connectorId);
    const executedNodes =
      existing && existing.scenarioKey === scenarioId
        ? [...existing.executedNodes, data.nodeId]
        : [data.nodeId];
    host.scenarioPositionByConnector.set(connectorId, {
      scenarioKey: scenarioId,
      lastCompletedNodeId: data.nodeId,
      executedNodes,
    });
    host.persistConnectorRuntime(connector, connectorId);
  });

  // Resume hint: if restoreConnectorRuntimeFromDatabase loaded a
  // position for this connector AND the saved node ids still exist in
  // the scenario we're about to run, hand it to the executor's start()
  // so it walks the graph from after lastCompletedNodeId. We can't
  // compare scenarioKey directly: scenario template instances get a
  // fresh `${templateId}-${cpId}-c${connectorId}-${Date.now()}-${suffix}`
  // id on every daemon boot, so the saved key never matches the new
  // run's id. Structural match (lastCompletedNodeId is a node in the
  // current scenario, every executedNode resolves too) is the
  // load-bearing check.
  const pending = host.pendingScenarioResumes.get(connectorId);
  const nodeIds = new Set(entry.definition.nodes.map((n) => n.id));
  const positionMatches =
    pending &&
    pending.lastCompletedNodeId != null &&
    nodeIds.has(pending.lastCompletedNodeId) &&
    pending.executedNodes.every((id) => nodeIds.has(id));
  const resumeOpts = positionMatches
    ? {
        resumeFromNodeId: pending!.lastCompletedNodeId ?? undefined,
        executedNodes: pending!.executedNodes,
      }
    : undefined;
  if (resumeOpts) {
    host.pendingScenarioResumes.delete(connectorId);
    // Rebase the position map to this run's scenarioId so subsequent
    // node.complete writes accumulate against the right key on the
    // next persistConnectorRuntime call.
    host.scenarioPositionByConnector.set(connectorId, {
      ...pending!,
      scenarioKey: scenarioId,
    });
  } else {
    // Acquisition, not cleanup: a run that is *not* resuming starts at the
    // beginning, so the connector's position is this run's from here and
    // whatever was there belongs to a run that is over. Clearing it on
    // acquire rather than leaving it for the previous run's `finally` is what
    // makes the position correct across a replacement — the outgoing run may
    // still be unwinding, and if it has been replaced it must not touch
    // connector state the new occupant now owns. Left behind, a restart in
    // the window before this run completes its first node resumed the *new*
    // graph from the *old* graph's node ids, which is persisted state and so
    // survives the restart that reads it (#314).
    //
    // "Belongs to a run that is over" is now asked rather than assumed. A
    // connector can carry two runs at once — the shipped default
    // (`essential-cp-behavior`, `triggerOn: connect`) auto-starts on every
    // connector and parks on `remoteStartTrigger` until a CSMS acts, so the
    // resting state of a default charge point is one run already in flight —
    // and this clear used to throw away that run's checkpoint on its way in.
    // The same ownership question `clearScenarioPositionIfOwned` asks on the
    // way out, asked on the way in: a position whose owner is still running
    // is not this run's to drop.
    const heldByLiveRun = scenarioPositionHeldByOtherLiveRun(
      host,
      connectorId,
      scenarioId,
    );
    if (!heldByLiveRun) {
      host.scenarioPositionByConnector.delete(connectorId);
      // Written through, not just dropped in memory. The artifact that
      // outlives a restart is the `connector_runtime` row, and it keeps the
      // previous graph's node ids until something persists over them —
      // which, without this, is the replacement's first completed node. A
      // restart inside that window is exactly the case being closed.
      host.persistConnectorRuntime(
        host.chargePoint.connectors.get(connectorId),
        connectorId,
      );
    }
  }

  const executor = new ScenarioExecutor(
    entry.definition,
    callbacks,
    eventEmitter,
  );
  host.executors.set(scenarioId, executor);
  host.executorConnectorIds.set(scenarioId, connectorId);

  host.emit({
    event: "scenario_started",
    data: { connectorId, scenarioId, runId },
  });

  executor.start(resumeOpts).finally(() => {
    // The invariant, asserted rather than assumed. Every teardown below is
    // keyed by `scenarioId`, so a *later* run of the same scenario that began
    // while this promise was queued would have its executor, run id and
    // transcript deleted by the run it replaced — and then be finalized under
    // the wrong verdict. Nothing should be able to start a replacement inside
    // that window (drains are entered only from points where cleanup is
    // complete), but "should" is what the last three ordering bugs in this
    // feature had in common. If this run is no longer the registered one its
    // bookkeeping has already been replaced, so the only correct action is to
    // touch none of it.
    const registered = host.executors.get(scenarioId);
    if (registered !== executor) {
      // `!== executor` covers two different situations and only one of them
      // means "someone else owns this bookkeeping now".
      //
      // *Replaced* — a later run registered its own executor under the same
      // id — is the case the guard was written for: touch nothing, or this
      // run deletes the live run's state and finalizes it under the wrong
      // verdict.
      //
      // *Deleted* — `stopScenario` / `stopAllScenarios` dropped the executor
      // synchronously and left this `finally` queued — is not. Nothing owns
      // the id, so this run is still responsible for its own remains. The
      // stop paths freeze the terminal status and finalize the run
      // themselves (redoing either here would overwrite their pre-stop
      // snapshot with a post-stop one), but they do not clear the persisted
      // scenario position — so skipping this left a manually stopped run's
      // last node in `connector_runtime`, and with `--state-db` the next boot
      // resumed the scenario the operator had stopped. Cleared here rather
      // than in each stop path: this callback runs whichever path stopped the
      // run, and there are two of them today (#314).
      //
      // The two questions are answered separately, because one early return
      // that answered both is what stranded the old run's obligations. *Whose
      // bookkeeping is this?* — the executor slot, the run id, the transcript,
      // the terminal status — belongs to whoever holds the slot now, so a
      // replaced run touches none of it. *Whose cleanup is owed?* — the
      // connector-scoped artifacts this run leaves behind — is owed whatever
      // happens to the slot, because nobody else will ever clear them.
      if (registered === undefined) {
        // Nothing owns the slot: this run's own bookkeeping is still its to
        // clear. The stop paths freeze the terminal status and finalize the
        // run themselves (redoing either here would overwrite their pre-stop
        // snapshot with a post-stop one), but they do not clear the persisted
        // scenario position — so skipping this left a manually stopped run's
        // last node in `connector_runtime`, and with `--state-db` the next
        // boot resumed the scenario the operator had stopped (#314).
        host.executorConnectorIds.delete(scenarioId);
        clearScenarioPositionIfOwned(host, connectorId, scenarioId);
      }
      releaseConnectorArtifacts(host, connector, connectorId, runId);
      host.persistConnectorRuntime(connector, connectorId);
      notifySessionSettled(host, { connectorId, scenarioId });
      return;
    }
    // Freeze the terminal status BEFORE dropping the executor, so
    // scenario_status keeps answering once this map entry is gone. A manual
    // stop takes the same snapshot in stopScenario, ahead of executor.stop().
    recordTerminalScenarioStatus(
      host,
      scenarioId,
      runId,
      hadError ? "error" : "completed",
      executor.getContext(),
      errorMessages,
    );
    host.executors.delete(scenarioId);
    host.executorConnectorIds.delete(scenarioId);
    host.runIdByScenario.delete(scenarioId);
    // Scenario exited cleanly — clear the persisted position so a
    // subsequent restart treats the connector as idle (the
    // connector_runtime row's transaction_json itself is already
    // null by the time the Stop Transaction node ran). Only if it is still
    // this run's: another scenario may have acquired the connector while
    // this `finally` sat queued.
    clearScenarioPositionIfOwned(host, connectorId, scenarioId);
    releaseConnectorArtifacts(host, connector, connectorId, runId);
    host.persistConnectorRuntime(connector, connectorId);
    // #179 Phase 2b: the run has settled (naturally or via error) --
    // stop capturing the transcript and compute this run's verdict. The
    // stop-path methods (stopScenario/stopAllScenarios) finalize
    // synchronously before this callback can fire (see their comments),
    // so finalizeScenarioRun's transcript guard makes this a no-op then.
    finalizeScenarioRun(
      host,
      scenarioId,
      connectorId,
      runId,
      hadError ? "error" : "completed",
      false,
      errorMessages,
      // #179 Phase 3: the executor clears its parked expectation in the
      // same `finally` block that lets a node's thrown error propagate
      // (see ScenarioExecutor.executeSingleNode), so by the time this
      // callback runs there's no expectation left to report -- best
      // effort here is "null", not a guess at what the node was waiting
      // for. The stop-path methods below capture it BEFORE stop()
      // clears it, which is the case that can be non-null.
      null,
    );
    // Last, deliberately: #314's held-reload drain calls loadScenario, which
    // can auto-start a fresh run of the same scenario. Announcing the settle
    // any earlier would let that new run install its transcript and run id
    // and then have this cleanup tear them down again.
    notifySessionSettled(host, { connectorId, scenarioId });
  });
}

/**
 * Release the connector-scoped artifacts a finished run leaves behind.
 *
 * Separate from the executor slot on purpose. The slot, the run id, the
 * transcript and the terminal status all belong to *whoever holds the slot
 * now*, so a run that has been replaced must not touch them. These do not:
 * they hang off the **connector**, nobody else will ever clear them, and they
 * are owed whether or not a replacement has taken the id.
 *
 * The decision itself is {@link shouldReleaseEvSettingsOverride}, asked
 * against `_evSettingsOwnerByConnector`: three formulations that read the
 * *definitions* map instead of the claim have already shipped, so the owner
 * is recorded where the claim happens and this only compares run ids.
 *
 * The scenario position needs no equivalent, because acquisition does the
 * work: `runScenario` clears it when it starts a run that is not resuming, so
 * a replacement owns a clean slate from its first instruction rather than
 * inheriting the previous graph's node ids. The override's owner is the same
 * idea — written on acquisition, by the run that actually takes it.
 *
 * Ordering: this runs from `runScenario`'s `finally`, which is queued as a
 * microtask, so a replacement started synchronously in the same tick is
 * already visible here — that interleaving is the one this exists for. What
 * is visible, though, is the replacement's *installation*; whether it has
 * claimed anything is a separate fact, and the owner is the only thing that
 * records it.
 */
export function releaseConnectorArtifacts(
  host: ScenarioRunHost,
  connector: ReturnType<typeof host.chargePoint.connectors.get>,
  connectorId: number,
  endingRunId: string,
): void {
  if (!connector) return;
  const owner = host.evSettingsOwnerByConnector.get(connectorId) ?? null;
  if (!shouldReleaseEvSettingsOverride(endingRunId, owner)) return;
  connector.clearEvSettingsOverride();
  // Hygiene, not correctness: the entry named an override that is now
  // released, and a run's teardown can reach here twice (a stop path
  // releases, then that run's queued `finally` does). No behaviour depends
  // on it — any competing claim rewrites this key (a later run) or deletes
  // it (an operator set) before the second call, so a stale entry could only
  // ever match the run that already released.
  host.evSettingsOwnerByConnector.delete(connectorId);
}

/** Tell {@link onSessionSettled} subscribers a gate has opened. A throwing
 *  handler is logged and never breaks the path it was called from. */
/**
 * Announce a settle — always on a later microtask, never inline (#314).
 *
 * This is the one place the invariant lives, because enumerating safe emit
 * sites kept missing one. The rule that actually holds is *not* "the gate the
 * listener checks is clear": a drain does not merely read that gate, it calls
 * `loadScenario`, which can auto-start a run that snapshots connector state
 * and starts a transcript. Its correctness therefore depends on state the
 * gate says nothing about. `transactionChange` fires from inside
 * `ChargePoint.stopTransaction` with the transaction already null but auto-
 * reset and scheduled-availability cleanup still to come; `resetScenario`
 * emits before its own meter and status cleanup. Both have an open gate and a
 * half-torn-down connector, which is exactly the combination four separate
 * bugs here have been.
 *
 * So the requirement is the stronger one: **no listener runs inside any
 * synchronous teardown, even one whose own gate has already opened.** A
 * microtask is precisely that guarantee — JavaScript runs the enclosing
 * synchronous block to completion first — and asserting it here covers every
 * emit site, including ones not yet written.
 */
export function notifySessionSettled(
  host: ScenarioRunHost,
  info: SessionSettledInfo,
): void {
  const handlers = [...host.sessionSettledHandlers];
  if (handlers.length === 0) return;
  queueMicrotask(() => {
    for (const handler of handlers) {
      // Re-checked: the service can be torn down between the emit and here.
      if (!host.sessionSettledHandlers.has(handler)) continue;
      try {
        handler(info);
      } catch (err) {
        process.stderr.write(`[CLI] Session settled handler error: ${err}\n`);
      }
    }
  });
}

/** Resolve (and clear) any pending waitForScenarioArmed() callers for
 *  `scenarioId`. Called from runScenario's onStateChange hook. */
export function resolveScenarioArmedWaiters(
  host: ScenarioRunHost,
  scenarioId: string,
): void {
  const waiters = host.armedWaitersByScenario.get(scenarioId);
  if (!waiters) return;
  host.armedWaitersByScenario.delete(scenarioId);
  waiters.forEach((resolve) => resolve());
}

/**
 * Freeze a finished run's context so `getScenarioStatus` keeps answering
 * after the executor is gone.
 *
 * `state` is taken from the run's `executionState` rather than whatever the
 * executor's machine settled on, so status and `scenario_report` can never
 * disagree about whether a run passed — a manual stop reports "completed"
 * on both surfaces, exactly as finalizeScenarioRun records it.
 */
export function recordTerminalScenarioStatus(
  host: ScenarioRunHost,
  scenarioId: string,
  runId: string,
  executionState: "completed" | "error",
  context: ScenarioExecutionContext,
  errors: ReadonlyArray<string>,
): void {
  host.lastRunStatusByScenario.set(scenarioId, {
    ...context,
    scenarioId,
    state: executionState === "error" ? "error" : "completed",
    // The run is over: nothing is parked and no node is mid-execution.
    expectation: null,
    currentNodeStartedAt: null,
    waitDeadlineAt: null,
    ...(errors.length > 0 ? { error: errors[0] } : {}),
    runId,
  });
}

/**
 * #179 Phase 2b: stop capturing this run's transcript, evaluate the
 * scenario's declared assertions (if any) against it, and store the
 * resulting {@link ScenarioRunResult}. A scenario with no `assertions`
 * evaluates to zero results, which computeVerdict resolves to SKIPPED --
 * unchanged behavior for every scenario written before this feature.
 *
 * Idempotent: the run's transcript is removed from
 * `_transcriptByScenario` the first time this runs for a given
 * scenarioId, so a second call for the same run (the stop-path methods
 * finalize synchronously, ahead of the microtask-deferred
 * executor.start().finally() callback racing them for the same run — see
 * their comments) is a no-op.
 */
export function finalizeScenarioRun(
  host: ScenarioRunHost,
  scenarioId: string,
  connectorId: number,
  runId: string,
  executionState: "completed" | "error",
  blocked: boolean,
  errors: string[],
  timeout: { nodeId: string; expectation?: unknown } | null,
  stopped = false,
): void {
  host.recorder.finalize({
    scenarioId,
    connectorId,
    runId,
    definition: host.scenarios.get(scenarioId)?.definition,
    executionState,
    blocked,
    errors,
    timeout,
    stopped,
  });
}
