import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import {
  loadScenario,
  saveScenario,
  deleteScenario,
  listScenarios,
} from "../../utils/scenarioStorage";
import type { ScenarioRepository } from "../interfaces/ScenarioRepository";

function keyOf(chargePointId: string, connectorId: number | null): string {
  return `${chargePointId}::${connectorId ?? "cp"}`;
}

export class LocalScenarioRepository implements ScenarioRepository {
  private readonly listeners = new Map<string, Set<(scenario: ScenarioDefinition | null) => void>>();

  async load(chargePointId: string, connectorId: number | null): Promise<ScenarioDefinition | null> {
    return loadScenario(chargePointId, connectorId);
  }

  async save(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition,
  ): Promise<void> {
    saveScenario(chargePointId, connectorId, scenario);
    this.notify(chargePointId, connectorId, scenario);
  }

  async delete(chargePointId: string, connectorId: number | null): Promise<void> {
    deleteScenario(chargePointId, connectorId);
    this.notify(chargePointId, connectorId, null);
  }

  async list(chargePointId: string): Promise<ScenarioDefinition[]> {
    return listScenarios(chargePointId);
  }

  subscribe(
    chargePointId: string,
    connectorId: number | null,
    handler: (scenario: ScenarioDefinition | null) => void,
  ): () => void {
    const key = keyOf(chargePointId, connectorId);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(handler);
    this.listeners.set(key, listeners);

    this.load(chargePointId, connectorId).then((value) => handler(value));

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  private notify(
    chargePointId: string,
    connectorId: number | null,
    scenario: ScenarioDefinition | null,
  ): void {
    const listeners = this.listeners.get(keyOf(chargePointId, connectorId));
    if (!listeners) return;
    listeners.forEach((listener) => {
      try {
        listener(scenario);
      } catch (error) {
        console.error('[LocalScenarioRepository] listener error', error);
      }
    });
  }
}
