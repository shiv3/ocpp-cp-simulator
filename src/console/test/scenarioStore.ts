import { vi, type Mock } from "vitest";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";

/**
 * An in-memory scenario definition store with the four per-scope methods of
 * `ChargePointService` as `vi.fn`s, for tests that need writes to be read
 * back (the Library, per-connector assignment). Spread `store.methods` into
 * `createFakeChargePointService`.
 */
export interface ScenarioStore {
  methods: {
    listScenarioDefinitions: Mock<
      ChargePointService["listScenarioDefinitions"]
    >;
    saveScenarioDefinition: Mock<ChargePointService["saveScenarioDefinition"]>;
    replaceConnectorScenarioDefinitions: Mock<
      ChargePointService["replaceConnectorScenarioDefinitions"]
    >;
    deleteScenarioDefinition: Mock<
      ChargePointService["deleteScenarioDefinition"]
    >;
  };
  get(cpId: string, connectorId: number | null): ScenarioDefinition[];
  set(
    cpId: string,
    connectorId: number | null,
    definitions: ScenarioDefinition[],
  ): void;
}

const keyOf = (cpId: string, connectorId: number | null) =>
  `${cpId}:${connectorId ?? "cp"}`;

export function createScenarioStore(): ScenarioStore {
  const scopes = new Map<string, ScenarioDefinition[]>();
  const get = (cpId: string, connectorId: number | null) => [
    ...(scopes.get(keyOf(cpId, connectorId)) ?? []),
  ];
  const set = (
    cpId: string,
    connectorId: number | null,
    definitions: ScenarioDefinition[],
  ) => {
    scopes.set(keyOf(cpId, connectorId), [...definitions]);
  };

  return {
    get,
    set,
    methods: {
      listScenarioDefinitions: vi.fn(
        async (cpId: string, connectorId: number | null) =>
          get(cpId, connectorId),
      ),
      saveScenarioDefinition: vi.fn(
        async (
          cpId: string,
          connectorId: number | null,
          definition: ScenarioDefinition,
        ) => {
          const rest = get(cpId, connectorId).filter(
            (d) => d.id !== definition.id,
          );
          set(cpId, connectorId, [definition, ...rest]);
          return definition;
        },
      ),
      replaceConnectorScenarioDefinitions: vi.fn(
        async (
          cpId: string,
          connectorId: number | null,
          definitions: readonly ScenarioDefinition[],
        ) => {
          set(cpId, connectorId, [...definitions]);
          return [...definitions];
        },
      ),
      deleteScenarioDefinition: vi.fn(
        async (cpId: string, connectorId: number | null, id: string) => {
          set(
            cpId,
            connectorId,
            get(cpId, connectorId).filter((d) => d.id !== id),
          );
        },
      ),
    },
  };
}
