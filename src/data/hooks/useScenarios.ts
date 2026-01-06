import { useCallback, useEffect, useState } from "react";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../providers/DataProvider";

interface UseScenariosResult {
  scenarios: ScenarioDefinition[];
  isLoading: boolean;
  saveScenario: (scenario: ScenarioDefinition) => Promise<void>;
  deleteScenario: () => Promise<void>;
}

export function useScenarios(chargePointId: string | null, connectorId: number | null): UseScenariosResult {
  const { scenarioRepository } = useDataContext();
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(chargePointId));

  useEffect(() => {
    if (!chargePointId) {
      setScenarios([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const list = await scenarioRepository.list(chargePointId);
        if (!cancelled) {
          setScenarios(
            list.filter((scenario) => {
              if (connectorId === null) {
                return scenario.targetType !== "connector";
              }

              if (scenario.targetType === "connector") {
                return scenario.targetId === connectorId;
              }

              // Backward compatibility: scenarios saved before targetType introduction
              return scenario.targetType !== "chargePoint";
            }),
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    const unsubscribe = scenarioRepository.subscribe(chargePointId, connectorId, (scenario) => {
      if (!scenario) {
        return;
      }

      setScenarios((prev) => {
        const other = prev.filter((item) => item.id !== scenario.id);
        return [...other, scenario];
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chargePointId, connectorId, scenarioRepository]);

  const saveScenario = useCallback(
    async (scenario: ScenarioDefinition) => {
      if (!chargePointId) return;
      await scenarioRepository.save(chargePointId, connectorId, scenario);
    },
    [chargePointId, connectorId, scenarioRepository],
  );

  const deleteScenario = useCallback(async () => {
    if (!chargePointId) return;
    await scenarioRepository.delete(chargePointId, connectorId);
    setScenarios([]);
  }, [chargePointId, connectorId, scenarioRepository]);

  return {
    scenarios,
    isLoading,
    saveScenario,
    deleteScenario,
  };
}
