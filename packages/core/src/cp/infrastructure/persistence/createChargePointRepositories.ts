import { NoopAuthorizationCacheRepository } from "../../domain/persistence/AuthorizationCacheRepository";
import type { ChargePointRepositories } from "../../domain/persistence/ChargePointRepositories";
import { NoopConnectorSettingsRepository } from "../../domain/persistence/ConnectorSettingsRepository";
import type { Database } from "../../domain/persistence/Database";
import { SqliteAuthorizationCacheRepository } from "./SqliteAuthorizationCacheRepository";
import { SqliteConnectorSettingsRepository } from "./SqliteConnectorSettingsRepository";

/** The repositories of charge point `cpId` (#878): its rows on `database`,
 *  or no-op stores without one (state kept in memory only). */
export function createChargePointRepositories(
  cpId: string,
  database: Database | null,
): ChargePointRepositories {
  if (!database) {
    return {
      authorizationCache: new NoopAuthorizationCacheRepository(),
      connectorSettings: new NoopConnectorSettingsRepository(),
    };
  }
  return {
    authorizationCache: new SqliteAuthorizationCacheRepository(cpId, database),
    connectorSettings: new SqliteConnectorSettingsRepository(cpId, database),
  };
}
