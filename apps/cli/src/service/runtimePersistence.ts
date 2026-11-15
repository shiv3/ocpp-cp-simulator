import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type {
  ConnectorRuntimeRepository,
  ScenarioPositionSnapshot,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ConnectorRuntimeRepository";
import { parsePersistedEngineState } from "@ocpp-cp-simulator/core/cp/application/engine/ChargerState";
import { SqliteEngineStateRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteEngineStateRepository";
import type { ChargePointInitOptions } from "../types";

/** What the runtime restore / persistence functions need from the service. */
export interface RuntimePersistenceHost {
  readonly chargePoint: ChargePoint;
  readonly init: ChargePointInitOptions;
  readonly database: Database | null;
  readonly runtimeRepo: ConnectorRuntimeRepository;
  readonly pendingScenarioResumes: Map<number, ScenarioPositionSnapshot>;
  readonly scenarioPositionByConnector: Map<number, ScenarioPositionSnapshot>;
  setAutoTrafficConfig(connectorId: number, config: AutoTrafficConfig): void;
}

/**
 * Rehydrate every connector's runtime state from the DB. Called by
 * the CP restore path after `instantiate()` but BEFORE the WebSocket
 * is opened: the snapshot uses
 * {@link Connector.restoreRuntimeSnapshot} which does NOT fire
 * statusChange / meter events, so listeners on the new service won't
 * accidentally push a duplicate StatusNotification to the CSMS the
 * moment we connect.
 *
 * Returns the number of connectors that had a stored snapshot
 * applied (i.e. were not at the default Available / 0 / null state).
 */
/**
 * Restart background traffic that was configured before the last shutdown
 * (#300).
 *
 * Separate from the runtime snapshot below because the config lives in
 * `connector_settings`, not the connector row. Without this the row survived
 * a restart and the charge point came back idle, with nothing to say the
 * configuration had been dropped — the opposite of what "persisted" means
 * for a feature whose whole job is to keep generating.
 */
export async function restoreAutoTrafficFromDatabase(
  host: RuntimePersistenceHost,
  repository: {
    loadAutoTrafficConfig(
      cpId: string,
      connectorId: number,
    ): Promise<AutoTrafficConfig | null>;
  },
): Promise<number> {
  if (!host.database) return 0;
  let started = 0;
  for (const connectorId of host.chargePoint.connectors.keys()) {
    const config = await repository.loadAutoTrafficConfig(
      host.init.cpId,
      connectorId,
    );
    if (!config?.enabled) continue;
    try {
      host.setAutoTrafficConfig(connectorId, config);
      started++;
    } catch {
      // A stored config that no longer validates must not stop the restore
      // for every other connector.
    }
  }
  return started;
}

export function restoreConnectorRuntimeFromDatabase(
  host: RuntimePersistenceHost,
): number {
  if (!host.database) return 0;
  let restored = 0;
  host.chargePoint.connectors.forEach((connector, connectorId) => {
    const snapshot = host.runtimeRepo.load(host.init.cpId, connectorId);
    if (!snapshot) return;
    connector.restoreRuntimeSnapshot(snapshot);
    // Capture the scenario position so the auto-start path can resume
    // the scenario at the saved node instead of replaying from `start`.
    // Stored on both _pendingScenarioResumes (for runScenario to
    // consume once) and _scenarioPositionByConnector (so the row stays
    // self-consistent on later connector-field-change writes that
    // happen before the executor is re-armed). The same snapshot is
    // intentionally placed in both maps; runScenario removes the
    // pending entry as soon as it hands the position to the executor.
    if (snapshot.scenarioPosition) {
      host.pendingScenarioResumes.set(connectorId, snapshot.scenarioPosition);
      host.scenarioPositionByConnector.set(
        connectorId,
        snapshot.scenarioPosition,
      );
    }
    restored += 1;
  });
  return restored;
}

/**
 * Keep the engine's own state (notification statuses, the `ctx.state` of
 * behaviors) in the `engine_state` row. Read back here, in the constructor,
 * so a behavior loaded afterwards adopts its stored `ctx.state` whatever the
 * order of restore and load; the row of a charge point that never existed is
 * absent and reads as the initial state. A stored value this build cannot
 * read is ignored.
 */
export function persistEngineState(
  host: RuntimePersistenceHost,
  database: Database,
  cpId: string,
): void {
  const repo = new SqliteEngineStateRepository(database);
  const engine = host.chargePoint.engine;
  const saved = parsePersistedEngineState(repo.load(cpId));
  if (saved) engine.restoreState(saved);
  // Normalized after the restore, so an untouched engine writes nothing.
  let lastSaved = JSON.stringify(engine.persistable());
  engine.onPersist(() => {
    const next = engine.persistable();
    const text = JSON.stringify(next);
    if (text === lastSaved) return;
    repo.save(cpId, next);
    lastSaved = text;
  });
}
