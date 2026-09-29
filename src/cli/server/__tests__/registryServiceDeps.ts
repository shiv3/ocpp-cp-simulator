import type { Database } from "../../../cp/domain/persistence/Database";
import { SqliteScenarioRepository } from "../../../cp/domain/persistence/SqliteScenarioRepository";
import { SqliteConnectorSettingsRepository } from "../../../data/sqlite/SqliteConnectorSettingsRepository";
import type { RegistryChargePointServiceDeps } from "../RegistryChargePointService";
import { createSocketConfigRepository } from "../socketServer";

/** The repositories a RegistryChargePointService gets from the daemon, over
 *  `database` (`null` keeps them in memory, like a daemon without
 *  `--state-db`). */
export function registryServiceDeps(
  database: Database | null = null,
): RegistryChargePointServiceDeps {
  return {
    database,
    configRepository: createSocketConfigRepository(database),
    scenarioRepository: new SqliteScenarioRepository(database),
    connectorSettingsRepository: new SqliteConnectorSettingsRepository(
      database,
    ),
  };
}
