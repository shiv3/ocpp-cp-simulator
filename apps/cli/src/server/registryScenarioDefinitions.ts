import { type ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { clearStartupProvenance } from "./startupScenarioRows";
import type { CPRegistry } from "./CPRegistry";
import type { RegistryChargePointServiceDeps } from "./RegistryChargePointService";

export class RegistryScenarioDefinitions {
  constructor(
    private readonly registry: CPRegistry,
    private readonly deps: RegistryChargePointServiceDeps,
  ) {}

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    await this.deps.scenarioRepository.save(id, connectorId, definition);
    // #338: a definition the operator saves is theirs, whatever generated it.
    clearStartupProvenance(this.deps.database, id, connectorId, [
      definition.id,
    ]);
    await this.deps.database?.flush?.();
    return definition;
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    await this.deps.scenarioRepository.replaceConnector(
      id,
      connectorId,
      definitions,
    );
    clearStartupProvenance(
      this.deps.database,
      id,
      connectorId,
      definitions.map((definition) => definition.id),
    );
    await this.deps.database?.flush?.();
    // #209: the DB is now authoritative, but the daemon runtime scenario map
    // (read by connect-auto-start) still holds the stale seeded default and
    // lacks the upload. Reconcile it so a connect-triggered scenario uploaded
    // from the web console actually fires on connect. No-op when the CP isn't
    // currently instantiated (definitions-only edit) — restore rebuilds it.
    this.registry
      .get(id)
      ?.syncConnectorRuntimeScenarios(connectorId, definitions);
    return [...definitions];
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    this.deps.scenarioRepository.deleteOne(id, connectorId, definitionId);
    await this.deps.database?.flush?.();
  }

  subscribeScenarioDefinitions(
    id: string,
    connectorId: number | null,
    handler: (definitions: ScenarioDefinition[]) => void,
  ): () => void {
    return this.deps.scenarioRepository.subscribe(id, connectorId, () => {
      handler(this.deps.scenarioRepository.listByConnector(id, connectorId));
    });
  }
}
