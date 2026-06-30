import type { ScenarioDefinition } from "../../application/scenario/ScenarioTypes";

export interface ScenarioRepository {
  load(
    chargePointId: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition | null>;
  save(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): Promise<void>;
  delete(chargePointId: string, connectorId: number | null): Promise<void>;
  list(chargePointId: string): Promise<ScenarioDefinition[]>;
  listByConnector(
    chargePointId: string,
    connectorId: number | null,
  ): ScenarioDefinition[];
  replaceConnector(
    chargePointId: string,
    connectorId: number | null,
    scenarios: readonly ScenarioDefinition[],
  ): Promise<void>;
  deleteOne(
    chargePointId: string,
    connectorId: number | null,
    scenarioId: string,
  ): void;
  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void;
}
