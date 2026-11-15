import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { ScenarioManager } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioManager";
import type { Connector } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { ChargingSessionRepository } from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import type { ScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRepository";
import type { SqliteScenarioRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteScenarioRepository";
import type { ConnectorSettingsRepository } from "@ocpp-cp-simulator/client/interfaces/ConnectorSettingsRepository";
import type { LocalScenarioRuntime } from "./LocalScenarioRuntime";

/** What the delegate modules (`localCpCommands`, `localConnectorOps`,
 *  `localScenarios`) need from LocalChargePointService. */
export interface LocalServiceHost {
  readonly chargePoints: ReadonlyMap<string, ChargePoint>;
  readonly scenarioRuntimes: ReadonlyMap<string, LocalScenarioRuntime>;
  readonly database: Database | null;
  readonly scenarioRepository: SqliteScenarioRepository;
  readonly scenarioRuns: ScenarioRunRepository;
  readonly chargingSessions: ChargingSessionRepository;
  readonly connectorSettingsRepository: ConnectorSettingsRepository;
}

export function getExistingChargePointOrThrow(
  chargePoints: ReadonlyMap<string, ChargePoint>,
  id: string,
): ChargePoint {
  const cp = chargePoints.get(id);
  if (!cp) {
    throw new Error(
      `ChargePoint ${id} not registered in LocalChargePointService`,
    );
  }
  return cp;
}

export function requireConnector(
  chargePoints: ReadonlyMap<string, ChargePoint>,
  id: string,
  connectorId: number,
) {
  const cp = getExistingChargePointOrThrow(chargePoints, id);
  const connector = cp.getConnector(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found on ${id}`);
  }
  return connector;
}

export function requireScenarioManager(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): ScenarioManager {
  const manager = scenarioManagerOf(
    host,
    id,
    requireConnector(host.chargePoints, id, connectorId),
  );
  if (!manager) throw new Error("Scenario manager not available");
  return manager;
}

export function scenarioManagerOf(
  host: LocalServiceHost,
  id: string,
  connector: Connector,
): ScenarioManager | undefined {
  return host.scenarioRuntimes.get(id)?.scenarioManager(connector.id);
}
