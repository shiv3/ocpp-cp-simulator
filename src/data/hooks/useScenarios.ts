import { useCallback, useEffect, useState } from "react";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { useDataContext } from "../providers/DataProvider";

interface UseScenariosResult {
  scenarios: ScenarioDefinition[];
  isLoading: boolean;
  saveScenario: (scenario: ScenarioDefinition) => Promise<void>;
  deleteScenario: () => Promise<void>;
}

function filterScenarioDefinitions(
  scenarios: ScenarioDefinition[],
  connectorId: number | null,
): ScenarioDefinition[] {
  return scenarios.filter((scenario) => {
    if (connectorId === null) {
      return scenario.targetType !== "connector";
    }

    if (scenario.targetType === "connector") {
      return scenario.targetId === connectorId;
    }

    // Backward compatibility: scenarios saved before targetType introduction.
    return scenario.targetType !== "chargePoint";
  });
}

export function useScenarios(
  chargePointId: string | null,
  connectorId: number | null,
): UseScenariosResult {
  const { chargePointService } = useDataContext();
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(chargePointId));

  useEffect(() => {
    if (!chargePointId) {
      setScenarios([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const applyDefinitions = (definitions: ScenarioDefinition[]) => {
      if (!cancelled) {
        setScenarios(filterScenarioDefinitions(definitions, connectorId));
      }
    };
    const load = async () => {
      setIsLoading(true);
      try {
        const list = await chargePointService.listScenarioDefinitions(
          chargePointId,
          connectorId,
        );
        applyDefinitions(list);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    const unsubscribe = chargePointService.subscribeScenarioDefinitions(
      chargePointId,
      connectorId,
      applyDefinitions,
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chargePointId, connectorId, chargePointService]);

  const saveScenario = useCallback(
    async (scenario: ScenarioDefinition) => {
      if (!chargePointId) return;
      await chargePointService.saveScenarioDefinition(
        chargePointId,
        connectorId,
        scenario,
      );
    },
    [chargePointId, connectorId, chargePointService],
  );

  const deleteScenario = useCallback(async () => {
    if (!chargePointId) return;
    await chargePointService.replaceConnectorScenarioDefinitions(
      chargePointId,
      connectorId,
      [],
    );
    setScenarios([]);
  }, [chargePointId, connectorId, chargePointService]);

  return {
    scenarios,
    isLoading,
    saveScenario,
    deleteScenario,
  };
}
