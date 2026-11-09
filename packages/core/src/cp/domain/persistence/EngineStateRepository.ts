/**
 * The charger engine's state between runs (see `engine_state` in the schema):
 * one JSON document per charge point. The repository stores text; reading it
 * back into a state is `parsePersistedEngineState`.
 */
export interface EngineStateRepository {
  load(cpId: string): unknown;
  save(cpId: string, state: unknown): void;
}
