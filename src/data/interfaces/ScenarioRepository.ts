import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";

export interface ScenarioRepository {
  load(chargePointId: string, connectorId: number | null): Promise<ScenarioDefinition | null>;
  save(chargePointId: string, connectorId: number | null, scenario: ScenarioDefinition): Promise<void>;
  delete(chargePointId: string, connectorId: number | null): Promise<void>;
  list(chargePointId: string): Promise<ScenarioDefinition[]>;
  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void;
}
