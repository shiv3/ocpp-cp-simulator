import type { CLIOptions } from "../types";
import { CLIChargePointService } from "../service";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { BehaviorLibrary } from "../behavior/BehaviorLibrary";
import { CPRegistry } from "../server/CPRegistry";
import { EventBus } from "../server/eventBus";
import { RegistryChargePointService } from "../server/RegistryChargePointService";
import { createSocketConfigRepository } from "../server/socketServer";
import type { SingleCpRuntimeTarget } from "../singleCpTarget";
import { SqliteConnectorSettingsRepository } from "@ocpp-cp-simulator/client/sqlite/SqliteConnectorSettingsRepository";
import { buildBootstrap } from "./serverOptions";

export async function loadBehavesOrExit(
  files: readonly string[],
  useBehaviors: readonly string[] = [],
): Promise<BehaviorLibrary> {
  if (files.length === 0) return BehaviorLibrary.of([]);
  try {
    const library = await BehaviorLibrary.fromFiles(files);
    library.check(useBehaviors);
    return library;
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

export function createStandaloneChargePointRuntime(
  options: CLIOptions,
  database: Database | null,
  behaviors: BehaviorLibrary = BehaviorLibrary.of([]),
): SingleCpRuntimeTarget {
  const bootstrap = buildBootstrap(options);
  if (!bootstrap) {
    throw new Error("cpId is required");
  }

  const bus = new EventBus();
  const registry = new CPRegistry(bus, database, {
    allowInsecureTlsKeyPerms: options.insecureTlsKeyPerms,
    behaviors,
  });
  const configRepository = createSocketConfigRepository(database);
  // #495: the registry's, which its charge points write to as well.
  const scenarioRepository = registry.scenarioDefinitions;
  const connectorSettingsRepository = new SqliteConnectorSettingsRepository(
    database,
  );
  const chargePointService = new RegistryChargePointService(registry, {
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
  });
  const standalone = CLIChargePointService.fromOptions(options, database);
  const selected = behaviors.select(
    (options.useBehaviors?.length ?? 0) > 0 ? options.useBehaviors : undefined,
  );
  behaviors.checkParams(selected, options.behaviorParams);
  standalone.loadBehaviors(selected, options.behaviorParams);
  const eventSource = registry.registerExisting(standalone);

  return {
    chargePointService,
    cpId: bootstrap.cpId,
    eventSource,
    cleanup: () => {
      registry.shutdownAll();
    },
  };
}
