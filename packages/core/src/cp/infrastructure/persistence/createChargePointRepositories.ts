import { NoopAuthorizationCacheRepository } from "../../domain/persistence/AuthorizationCacheRepository";
import type { ChargePointRepositories } from "../../domain/persistence/ChargePointRepositories";
import { NoopConfigurationOverrideRepository } from "../../domain/persistence/ConfigurationOverrideRepository";
import { NoopConnectorSettingsRepository } from "../../domain/persistence/ConnectorSettingsRepository";
import type { Database } from "../../domain/persistence/Database";
import { NoopVariableMonitorRepository } from "../../domain/persistence/VariableMonitorRepository";
import { SqliteAuthorizationCacheRepository } from "./SqliteAuthorizationCacheRepository";
import { SqliteConfigurationOverrideRepository } from "./SqliteConfigurationOverrideRepository";
import { SqliteConnectorSettingsRepository } from "./SqliteConnectorSettingsRepository";
import { SqliteVariableMonitorRepository } from "./SqliteVariableMonitorRepository";

/** The repositories of charge point `cpId` (#878): its rows on `database`,
 *  or no-op stores without one (state kept in memory only). */
export function createChargePointRepositories(
  cpId: string,
  database: Database | null,
): ChargePointRepositories {
  if (!database) {
    return {
      authorizationCache: new NoopAuthorizationCacheRepository(),
      configuration: new NoopConfigurationOverrideRepository(),
      connectorSettings: new NoopConnectorSettingsRepository(),
      variableMonitors: new NoopVariableMonitorRepository(),
    };
  }
  return {
    authorizationCache: new SqliteAuthorizationCacheRepository(cpId, database),
    configuration: new SqliteConfigurationOverrideRepository(cpId, database),
    connectorSettings: new SqliteConnectorSettingsRepository(cpId, database),
    variableMonitors: new SqliteVariableMonitorRepository(cpId, database),
  };
}
