import type { ChargePointRepositories } from "../../domain/persistence/ChargePointRepositories";
import { NoopConnectorSettingsRepository } from "../../domain/persistence/ConnectorSettingsRepository";
import type { Database } from "../../domain/persistence/Database";
import { SqliteConnectorSettingsRepository } from "./SqliteConnectorSettingsRepository";

/** The repositories of charge point `cpId` (#878): its rows on `database`,
 *  or no-op stores without one (state kept in memory only). */
export function createChargePointRepositories(
  cpId: string,
  database: Database | null,
): ChargePointRepositories {
  if (!database) {
    return {
      connectorSettings: new NoopConnectorSettingsRepository(),
    };
  }
  return {
    connectorSettings: new SqliteConnectorSettingsRepository(cpId, database),
  };
}
