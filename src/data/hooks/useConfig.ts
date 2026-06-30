import { useCallback, useEffect, useState } from "react";

import type { SimulatorConfigInput, WireSimulatorConfig } from "../../protocol";
import { useDataContext } from "../providers/DataProvider";

interface UseConfigResult {
  config: WireSimulatorConfig | null;
  setConfig: (next: SimulatorConfigInput | null) => Promise<void>;
  isLoading: boolean;
}

export function useConfig(): UseConfigResult {
  const { chargePointService } = useDataContext();
  const [config, setConfigState] = useState<WireSimulatorConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    chargePointService
      .loadConfig()
      .then((value) => {
        if (!cancelled) {
          setConfigState(value);
          setIsLoading(false);
        }
      })
      .catch((error) => {
        console.error("Failed to load config", error);
        setIsLoading(false);
      });

    const unsubscribe = chargePointService.subscribeConfig((value) => {
      setConfigState(value);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chargePointService]);

  const setConfig = useCallback(
    async (next: SimulatorConfigInput | null) => {
      await chargePointService.saveConfig(next);
    },
    [chargePointService],
  );

  return { config, setConfig, isLoading };
}
