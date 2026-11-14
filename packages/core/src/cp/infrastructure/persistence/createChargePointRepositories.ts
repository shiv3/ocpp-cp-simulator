import { NoopAuthorizationCacheRepository } from "../../domain/persistence/AuthorizationCacheRepository";
import { NoopCertificateRepository } from "../../domain/persistence/CertificateRepository";
import type { ChargePointRepositories } from "../../domain/persistence/ChargePointRepositories";
import { NoopConfigurationOverrideRepository } from "../../domain/persistence/ConfigurationOverrideRepository";
import { NoopConnectorSettingsRepository } from "../../domain/persistence/ConnectorSettingsRepository";
import type { Database } from "../../domain/persistence/Database";
import { NoopModemRepository } from "../../domain/persistence/ModemRepository";
import { NoopPendingMessageRepository } from "../../domain/persistence/PendingMessageRepository";
import { NoopVariableMonitorRepository } from "../../domain/persistence/VariableMonitorRepository";
import { SqliteAuthorizationCacheRepository } from "./SqliteAuthorizationCacheRepository";
import { SqliteCertificateRepository } from "./SqliteCertificateRepository";
import { SqliteConfigurationOverrideRepository } from "./SqliteConfigurationOverrideRepository";
import { SqliteConnectorSettingsRepository } from "./SqliteConnectorSettingsRepository";
import { SqliteModemRepository } from "./SqliteModemRepository";
import { SqlitePendingMessageRepository } from "./SqlitePendingMessageRepository";
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
      certificates: new NoopCertificateRepository(),
      configuration: new NoopConfigurationOverrideRepository(),
      connectorSettings: new NoopConnectorSettingsRepository(),
      modem: new NoopModemRepository(),
      pendingMessages: new NoopPendingMessageRepository(),
      variableMonitors: new NoopVariableMonitorRepository(),
    };
  }
  return {
    authorizationCache: new SqliteAuthorizationCacheRepository(cpId, database),
    certificates: new SqliteCertificateRepository(cpId, database),
    configuration: new SqliteConfigurationOverrideRepository(cpId, database),
    connectorSettings: new SqliteConnectorSettingsRepository(cpId, database),
    modem: new SqliteModemRepository(cpId, database),
    pendingMessages: new SqlitePendingMessageRepository(cpId, database),
    variableMonitors: new SqliteVariableMonitorRepository(cpId, database),
  };
}
