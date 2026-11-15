import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import { ScenarioRunStateError } from "@ocpp-cp-simulator/core/cp/domain/errors/ScenarioRunStateError";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import {
  finalizeScenarioRun,
  recordTerminalScenarioStatus,
  releaseConnectorArtifacts,
  notifySessionSettled,
  type ScenarioRunHost,
} from "./scenarioRun";

/**
 * Opt-in companion to runScenario (see run_scenario's `awaitArmed` param):
 * resolves once the named run has either parked on its first expectation
 * ("waiting" — e.g. a RemoteStartTrigger node armed
 * registerScenarioHandler) or ended without ever parking. Without this, a
 * caller that fires the CSMS-initiated command a scenario is meant to
 * intercept immediately after run_scenario returns can race the trigger
 * node's arming and have the command silently handled outside the
 * scenario (see ScenarioRuntime.waitForRemoteStart/waitForRemoteStop).
 *
 * Resolves immediately if the run has already reached such a state by the
 * time this is called (e.g. an already-armed trigger, or a scenario with
 * no waiting nodes that finished before this was awaited), and is bounded
 * by `maxWaitMs` so a scenario whose first node is a long delay can't hang
 * the caller — it just resolves at the bound, same as not having awaited
 * at all. Never rejects.
 */
export function waitForScenarioArmed(
  host: ScenarioRunHost,
  scenarioId: string,
  maxWaitMs = 15_000,
): Promise<void> {
  const executor = host.executors.get(scenarioId);
  const state = executor?.getContext().state;
  if (
    !executor ||
    state === "waiting" ||
    state === "completed" ||
    state === "error" ||
    state === "idle"
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop this resolver from the map so a timed-out waiter doesn't
      // linger for the scenario's whole lifetime. resolveScenarioArmedWaiters
      // clears the entry wholesale on arming, but a long-running scenario
      // that never arms would otherwise accumulate one stale closure per
      // timed-out call.
      const waiters = host.armedWaitersByScenario.get(scenarioId);
      if (waiters) {
        const index = waiters.indexOf(done);
        if (index !== -1) waiters.splice(index, 1);
        if (waiters.length === 0) {
          host.armedWaitersByScenario.delete(scenarioId);
        }
      }
      resolve();
    };
    const waiters = host.armedWaitersByScenario.get(scenarioId) ?? [];
    waiters.push(done);
    host.armedWaitersByScenario.set(scenarioId, waiters);
    const timer = setTimeout(done, maxWaitMs);
  });
}

export function stepScenario(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
  force = false,
): void {
  const executor = requireRunningExecutor(host, connectorId, scenarioId);
  if (force) executor.forceStep();
  else executor.step();
}

/** #240: push the parked wait's deadline back by `seconds`. */
export function extendScenarioWait(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
  seconds: number,
): void {
  requireRunningExecutor(host, connectorId, scenarioId).extendWait(seconds);
}

/** #240: withdraw the parked wait and arm it again with its full timeout. */
export function retryScenarioWait(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): void {
  requireRunningExecutor(host, connectorId, scenarioId).retryWait();
}

/** #240: move past the parked wait without the awaited event. */
export function continueScenarioWait(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): void {
  requireRunningExecutor(host, connectorId, scenarioId).continueWait();
}

export function requireRunningExecutor(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): ScenarioExecutor {
  const entry = host.scenarios.get(scenarioId);
  if (!entry)
    throw new ScenarioRunStateError(`Scenario ${scenarioId} not found`);
  if (entry.connectorId !== connectorId) {
    throw new ScenarioRunStateError(
      `Scenario ${scenarioId} is not loaded for connector ${connectorId}`,
    );
  }
  const executor = host.executors.get(scenarioId);
  if (!executor) {
    throw new ScenarioRunStateError(`Scenario ${scenarioId} is not running`);
  }
  return executor;
}

/**
 * Returns the loaded scenario definition for a given connector + id, or
 * null if the scenario is not loaded on this CP. Used by remote browser
 * clients to see what the daemon has loaded (e.g. via
 * --scenario-template-file).
 */
export function getScenario(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): ScenarioDefinition | null {
  const entry = host.scenarios.get(scenarioId);
  if (!entry || entry.connectorId !== connectorId) return null;
  return entry.definition;
}

/**
 * Live status while a run is in flight, otherwise the terminal status of the
 * last finished run — so a poller waiting for `state === "completed"` can
 * actually observe it. Still null for a scenarioId with no run on record,
 * which is what lets a caller tell "unknown scenario" from "already
 * finished".
 */
export function getScenarioStatus(
  host: ScenarioRunHost,
  _connectorId: number,
  scenarioId: string,
): ScenarioExecutionContext | null {
  const executor = host.executors.get(scenarioId);
  if (!executor) {
    return host.lastRunStatusByScenario.get(scenarioId) ?? null;
  }
  // #179: echo the run id so a poller can tie this status to a specific run.
  const runId = host.runIdByScenario.get(scenarioId);
  return { ...executor.getContext(), runId };
}

/**
 * #179 Phase 2b: the verdict + assertion results for a scenario run, or
 * null if no run has finished yet (or the given runId doesn't match a
 * stored result for this scenario). Omitting runId returns the latest
 * recorded run for the scenario. Retention is the run history's (#388:
 * `MAX_RUNS_PER_CP` per charge point, persisted with `--state-db`). Phase 3
 * surfaces this over RPC as `scenario_report`.
 */
export function getScenarioRunResult(
  host: ScenarioRunHost,
  scenarioId: string,
  runId?: string,
): ScenarioRunResult | null {
  const cpId = host.chargePoint.id;
  const result =
    runId === undefined
      ? host.runs.latest(cpId, scenarioId)
      : host.runs.get(cpId, runId);
  if (!result || result.scenarioId !== scenarioId) return null;
  return result;
}

/**
 * #179 Phase 3: the `scenario_report` facade entry point — the full
 * per-run report (verdict + assertions + transcript + snapshots) for a
 * finished run, or null if none has finished. `connectorId` is accepted
 * for facade-signature symmetry; runs are keyed by scenarioId. Omitting
 * runId returns the latest recorded run.
 */
export function getScenarioReport(
  host: ScenarioRunHost,
  _connectorId: number,
  scenarioId: string,
  runId?: string,
): ScenarioRunResult | null {
  return host.getScenarioRunResult(scenarioId, runId);
}

export function stopScenario(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): void {
  const executor = host.executors.get(scenarioId);
  if (!executor) {
    throw new ScenarioRunStateError(`Scenario ${scenarioId} is not running`);
  }
  tearDownStoppedRun(host, connectorId, scenarioId, executor);
}

/**
 * #179 Phase 4: scenario-scoped reset. Unlike the global `state.reset`
 * (`resetAllState` wipes every CP + the DB), this returns just ONE connector
 * to a clean baseline so a campaign can run the next scenario without
 * leakage from the previous one. Steps: stop the run if active (reusing
 * `stopScenario`, which aborts the executor, finalizes + drops its
 * transcript, and clears armed response overrides), then clear any active
 * transaction and reservation on the connector, zero its meter, return it to
 * Available (emitting the StatusNotification so a CSMS stays in sync), and
 * drop the persisted scenario position.
 */
export function resetScenario(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
): void {
  const stoppedRun = host.executors.has(scenarioId);
  if (stoppedRun) {
    host.stopScenario(connectorId, scenarioId);
  }

  const connector = host.chargePoint.connectors.get(connectorId);
  if (!connector) return;

  connector.detachTransaction();
  // The setter does not emit `transactionChange`, so nothing else would
  // announce this one (#314) — but only announce it here when there was no
  // run to stop. `stopScenario` drops the executor synchronously and leaves
  // its `start()` promise's `finally` queued as a microtask; announcing now
  // drains a held reload *inside* that window, and a reloaded definition with
  // a matching connect trigger can auto-start immediately, whereupon the old
  // `finally` runs and tears down the run it never started. The stopped run's
  // own post-cleanup notification does the drain instead, which keeps one
  // terminator per run rather than two racing ones.
  if (!stoppedRun) {
    notifySessionSettled(host, { connectorId, scenarioId: null });
  }

  // Only the reservation made for this connector: a connector-0 one is
  // nobody's session to clear (#595).
  const reservation =
    host.chargePoint.reservationManager.reservationOn(connectorId);
  if (reservation) {
    host.chargePoint.reservationManager.cancelReservation(
      reservation.reservationId,
    );
  }

  host.chargePoint.setMeterValue(connectorId, 0);
  // Cleared BEFORE the connector goes back to Available, not after (#314).
  // That transition is handled synchronously and can auto-start another
  // scenario, which acquires the position and may write a checkpoint before
  // this method's next statement runs — so clearing afterwards threw away
  // the incoming run's position instead of the outgoing run's.
  host.scenarioPositionByConnector.delete(connectorId);
  host.chargePoint.updateConnectorStatus(connectorId, OCPPStatus.Available);
}

export function stopAllScenarios(
  host: ScenarioRunHost,
  connectorId: number,
): void {
  for (const [scenarioId, entry] of host.scenarios) {
    if (entry.connectorId !== connectorId) continue;
    const executor = host.executors.get(scenarioId);
    if (!executor) continue;
    tearDownStoppedRun(host, connectorId, scenarioId, executor);
  }
}

/**
 * Everything a manual stop does once the run to stop has been identified.
 *
 * Shared rather than repeated, because it had already drifted: this body used
 * to exist twice and only `stopScenario`'s copy froze the terminal status, so
 * a bulk stop left `scenario_status` and `list_scenarios` answering null or
 * with the previous run's verdict. That divergence also invalidated the
 * argument for putting the stopped-run cleanup in `runScenario`'s `finally`
 * — "the stop paths already record it" was true of one of them (#314).
 *
 * Order matters and is the same as it was: the terminal status and the
 * timeout are captured from the **pre-stop** context, because `executor.stop()`
 * clears the parked expectation and moves the run's state on, and a snapshot
 * taken afterwards would describe where the run is not.
 */
export function tearDownStoppedRun(
  host: ScenarioRunHost,
  connectorId: number,
  scenarioId: string,
  executor: ScenarioExecutor,
): void {
  // #179: capture the run id before stop() — executor.stop() lets the
  // start() promise settle, whose finally() clears _runIdByScenario.
  const runId = host.runIdByScenario.get(scenarioId) ?? "";
  // #179 Phase 2b: capture whether the run was parked on a waiting node
  // BEFORE stop() clears currentExpectation — a scenario stopped mid-wait
  // couldn't reach a verifiable state, so its verdict should be BLOCKED
  // rather than a possibly-misleading FAIL/PASS off a truncated transcript.
  const ctxBeforeStop = executor.getContext();
  const wasWaiting = ctxBeforeStop.state === "waiting";
  // #179 Phase 3: a stop mid-wait is the closest thing to a timeout the
  // report can attribute — record which node was parked and what it awaited.
  const timeout =
    wasWaiting && ctxBeforeStop.currentNodeId
      ? {
          nodeId: ctxBeforeStop.currentNodeId,
          expectation: ctxBeforeStop.expectation,
        }
      : null;
  // Same terminal-status freeze as runScenario's finally(), taken from the
  // pre-stop context so currentNodeId/executedNodes describe where the run
  // actually was. finalizeScenarioRun below records this stop as "completed";
  // keep the two surfaces in step.
  recordTerminalScenarioStatus(
    host,
    scenarioId,
    runId,
    "completed",
    ctxBeforeStop,
    [],
  );
  executor.stop();
  host.executors.delete(scenarioId);
  host.runIdByScenario.delete(scenarioId);
  // Release the EV settings override (#105) — only when this run actually
  // claimed it; see runScenario's executor.start().finally() for the
  // natural-completion counterpart. The same rule as a natural finish,
  // through the same path — a second copy of this rule is how the first
  // three formulations drifted. `runId` was captured above, before
  // executor.stop() let the start() promise settle and clear it, so the
  // owner comparison still has an id to make.
  releaseConnectorArtifacts(
    host,
    host.chargePoint.connectors.get(connectorId),
    connectorId,
    runId,
  );
  // Surface the stop to remote subscribers — executor.stop() bypasses
  // the onStateChange("completed") path used by runScenario(), so the
  // browser's active-scenario tracker would otherwise still believe
  // this scenario is running.
  host.emit({
    event: "scenario_completed",
    data: { connectorId, scenarioId, runId },
  });
  // #179 Phase 2b: finalize now, synchronously, before executor.start()'s
  // own .finally() (deferred to a microtask by the abort machinery) can
  // race it — finalizeScenarioRun's transcript guard makes that later
  // call a no-op. A manual stop collects no error message.
  finalizeScenarioRun(
    host,
    scenarioId,
    connectorId,
    runId,
    "completed",
    wasWaiting,
    [],
    timeout,
    true,
  );
}
