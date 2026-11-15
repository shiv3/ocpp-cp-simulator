import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { AutoTrafficRunner } from "@ocpp-cp-simulator/core/cp/application/services/AutoTrafficRunner";
import type { AutoTrafficIdTagPicker } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { ChargePointInitOptions } from "../types";
import type { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ChargingSessionRecorder } from "@ocpp-cp-simulator/core/cp/application/services/ChargingSessionRecorder";
import {
  type ConnectorRuntimeRepository,
  type ScenarioPositionSnapshot,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ConnectorRuntimeRepository";
import type { StateHistoryEntry } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import { redactSensitiveText } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import type {
  CLIEvent,
  EventHandler,
  SessionSettledHandler,
} from "./cliEvents";

/** What the teardown, timeline and persistence functions need from `CLIChargePointService`. */
export interface ServiceLifecycleHost {
  readonly chargePoint: ChargePoint;
  readonly executors: Map<string, ScenarioExecutor>;
  readonly scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  >;
  readonly recorder: ScenarioRunRecorder;
  readonly lastRunStatusByScenario: Map<string, ScenarioExecutionContext>;
  readonly evSettingsOwnerByConnector: Map<number, string>;
  readonly autoTraffic: Map<number, AutoTrafficRunner>;
  readonly autoTrafficPickers: Map<number, AutoTrafficIdTagPicker | null>;
  readonly sessionRecorder: ChargingSessionRecorder;
  readonly handlers: Set<EventHandler>;
  readonly sessionSettledHandlers: Set<SessionSettledHandler>;
  readonly runtimeRepo: ConnectorRuntimeRepository;
  readonly init: ChargePointInitOptions;
  readonly scenarioPositionByConnector: Map<number, ScenarioPositionSnapshot>;
  unsubscribes: Array<() => void>;
  connectorUnsubscribes: Array<() => void>;
  emit(evt: CLIEvent): void;
}

export function cleanup(
  host: ServiceLifecycleHost,
  permanent: boolean = false,
): void {
  for (const executor of host.executors.values()) {
    executor.stop();
  }
  host.executors.clear();
  host.scenarios.clear();
  // #179 Phase 2b: drop any in-flight transcript subscriptions so a
  // torn-down service doesn't leave stale Logger listeners behind. No
  // verdicts are computed here (the whole service is going away).
  host.recorder.dispose();
  // The scenario map is gone, so no id can be asked about any more.
  host.lastRunStatusByScenario.clear();
  // Every run this service knew about is over, so no run owns a connector's
  // EV settings override any more. The connectors go with the charge point
  // below, and a `CPRegistry.update` rebuild installs fresh ones — an owner
  // left here would name a run that cannot come back (#314).
  host.evSettingsOwnerByConnector.clear();
  // Permanent deletion uses dispose() to cancel controller timers;
  // non-permanent (update, shutdown) uses disconnect().
  // Before the permanent/temporary split: `CPRegistry.update` cleans up with
  // `permanent = false` and then replaces the service, so a runner left
  // going here would keep generating wire work from a discarded instance,
  // alongside its replacement.
  for (const runner of host.autoTraffic.values()) runner.stop();
  host.autoTraffic.clear();
  host.autoTrafficPickers.clear();

  // #447: detached before the teardown, so a shutdown leaves running
  // sessions open for the next start to reconcile.
  host.sessionRecorder.dispose();
  if (permanent) {
    // The station is gone for good: a `main` that writes `ctx.state` while it
    // stops must not bring the `engine_state` row back for the next station
    // under this id.
    host.chargePoint.engine.onPersist(null);
    host.chargePoint.dispose();
  } else {
    // #538: the periodic monitors keep their timers offline. Stopped
    // first, so the disconnect does not re-arm them on an instance that
    // `CPRegistry.update` is about to replace.
    host.chargePoint.stopMonitoring();
    // #537: a manual disconnect keeps the renewed certificate wait, but
    // this instance is being replaced (`CPRegistry.update`) or the process
    // is stopping: its wait, store listener and in-memory keys go too.
    host.chargePoint.releaseRenewedClientCertificate();
    host.chargePoint.disconnect();
    // The engine of a discarded instance stops with it: its `main` loops,
    // hooks and open exchanges would run on beside the replacement, and its
    // persist listener would keep overwriting the `engine_state` row the
    // replacement owns now. The row itself stays (an update keeps it).
    host.chargePoint.engine.onPersist(null);
    host.chargePoint.engine.dispose();
  }
  detachConnectorEventForwarders(host);
  for (const unsub of host.unsubscribes) {
    unsub();
  }
  host.unsubscribes = [];
  host.handlers.clear();
  host.sessionSettledHandlers.clear();
}

export function detachConnectorEventForwarders(
  host: ServiceLifecycleHost,
): void {
  for (const unsub of host.connectorUnsubscribes) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  host.connectorUnsubscribes = [];
}

export function attachStateHistoryForwarder(host: ServiceLifecycleHost): void {
  const history = host.chargePoint.stateManager.history;
  // StateHistory emits an "entry" event whenever a transition is recorded.
  // Fall back to no-op if the underlying impl doesn't expose subscribe.
  const subscribe = (
    history as unknown as {
      subscribe?: (cb: (entry: StateHistoryEntry) => void) => () => void;
    }
  ).subscribe;
  if (typeof subscribe === "function") {
    host.unsubscribes.push(
      subscribe.call(history, (entry: StateHistoryEntry) => {
        host.emit({ event: "state_history_entry", data: { entry } });
      }),
    );
  }
}

export function setupMeterValueCallbacks(host: ServiceLifecycleHost): void {
  host.chargePoint.connectors.forEach((connector) => {
    connector.setOnMeterValueSend((id) => {
      host.chargePoint.sendScheduledMeterValue(id);
    });
  });
}

/**
 * Persist the connector's current runtime snapshot to the daemon DB.
 * Called from every event listener that touches a persisted field
 * (status, availability, transaction, meter, soc). No-op when the
 * daemon is running without `--state-db`. Errors are swallowed and
 * logged: a transient SQLite write failure should not crash an
 * in-flight OCPP transaction.
 */
export function persistConnectorRuntime(
  host: ServiceLifecycleHost,
  connector: ReturnType<typeof host.chargePoint.connectors.get>,
  connectorId: number,
): void {
  if (!connector) return;
  try {
    host.runtimeRepo.save(host.init.cpId, connectorId, {
      ...connector.snapshotRuntime(),
      // Persist whichever scenario position we last captured for this
      // connector, so the row stays a self-consistent snapshot even
      // when the trigger is a connector field change (status/meter/…)
      // rather than a scenario node completion.
      scenarioPosition:
        host.scenarioPositionByConnector.get(connectorId) ?? null,
    });
  } catch (err) {
    console.warn(
      `[service] failed to persist connector_runtime for ` +
        `${host.init.cpId}:${connectorId}`,
      err,
    );
  }
}

/** #448: scenario runs are minted here, not in the domain, so their
 *  lifecycle reaches the operational timeline from the events announcing
 *  it. `startRun` attributes the connector's later entries to the run;
 *  `finalizeScenarioRun` ends it and records its outcome — not the
 *  `scenario_completed` event, which a manual stop also sends. */
export function recordScenarioOnTimeline(
  host: ServiceLifecycleHost,
  evt: CLIEvent,
): void {
  let detail: { summary: string; data?: Record<string, unknown> };
  switch (evt.event) {
    case "scenario_started":
      host.chargePoint.timeline.startRun(evt.data.connectorId, evt.data.runId);
      detail = { summary: "started" };
      break;
    case "scenario_wait_changed":
      detail = {
        summary: `wait on ${evt.data.nodeId} ${evt.data.kind}`,
        data: { nodeId: evt.data.nodeId, kind: evt.data.kind },
      };
      break;
    case "scenario_error": {
      const error = redactSensitiveText(evt.data.error);
      detail = { summary: `failed: ${error}`, data: { error } };
      break;
    }
    default:
      return;
  }
  const { connectorId, scenarioId, runId } = evt.data;
  host.chargePoint.timeline.record({
    kind: evt.event,
    connectorId,
    runId,
    summary: `Scenario ${scenarioId} ${detail.summary}`,
    data: { scenarioId, ...detail.data },
  });
}
