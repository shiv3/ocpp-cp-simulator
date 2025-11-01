import { useCallback, useEffect, useState } from "react";

import type { Config } from "../../store/store";
import { useDataContext } from "../providers/DataProvider";

interface UseConfigResult {
  config: Config | null;
  setConfig: (next: Config | null) => Promise<void>;
  isLoading: boolean;
}

export function useConfig(): UseConfigResult {
  const { configRepository } = useDataContext();
  const [config, setConfigState] = useState<Config | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    configRepository
      .load()
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

    const unsubscribe = configRepository.subscribe((value) => {
      setConfigState(value);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [configRepository]);

  const setConfig = useCallback(
    async (next: Config | null) => {
      await configRepository.save(next);
    },
    [configRepository],
  );

  return { config, setConfig, isLoading };
}
