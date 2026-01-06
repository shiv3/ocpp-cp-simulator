import React, { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { Provider as JotaiProvider } from "jotai";
import { createStore } from "jotai/vanilla";

import { resolveRuntimeMode, type RuntimeMode } from "../RuntimeMode";
import type { ConfigRepository } from "../interfaces/ConfigRepository";
import type { ScenarioRepository } from "../interfaces/ScenarioRepository";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";
import type { ChargePointService } from "../interfaces/ChargePointService";
import type { StateHistoryProvider } from "../interfaces/StateHistoryProvider";
import { LocalConfigRepository } from "../local/LocalConfigRepository";
import { LocalScenarioRepository } from "../local/LocalScenarioRepository";
import { LocalConnectorSettingsRepository } from "../local/LocalConnectorSettingsRepository";
import { LocalChargePointService } from "../local/LocalChargePointService";
import { LocalStateHistoryProvider } from "../local/LocalStateHistoryProvider";

interface DataContextValue {
  mode: RuntimeMode;
  configRepository: ConfigRepository;
  scenarioRepository: ScenarioRepository;
  connectorSettingsRepository: ConnectorSettingsRepository;
  chargePointService: ChargePointService;
  stateHistoryProvider: StateHistoryProvider;
}

const DataContext = createContext<DataContextValue | null>(null);

interface DataProviderProps {
  children: ReactNode;
  modeOverride?: RuntimeMode;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children, modeOverride }) => {
  const runtimeMode = useMemo(() => resolveRuntimeMode(modeOverride), [modeOverride]);
  const jotaiStore = useMemo(() => createStore(), []);

  const configRepository = useMemo<ConfigRepository>(() => new LocalConfigRepository(jotaiStore), [jotaiStore]);
  const scenarioRepository = useMemo<ScenarioRepository>(() => new LocalScenarioRepository(), []);
  const connectorSettingsRepository = useMemo<ConnectorSettingsRepository>(
    () => new LocalConnectorSettingsRepository(),
    [],
  );
  const localChargePointService = useMemo(() => new LocalChargePointService(), []);
  const chargePointService: ChargePointService = localChargePointService;
  const stateHistoryProvider = useMemo<StateHistoryProvider>(
    () => new LocalStateHistoryProvider(localChargePointService),
    [localChargePointService],
  );

  if (runtimeMode === "remote") {
    console.warn(
      "Remote runtime mode requested, but GraphQL adapters are not implemented yet. Falling back to local mode.",
    );
  }

  const value = useMemo(() => ({
    mode: runtimeMode === "remote" ? "local" : runtimeMode,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
    chargePointService,
    stateHistoryProvider,
  }), [runtimeMode, configRepository, scenarioRepository, connectorSettingsRepository, chargePointService, stateHistoryProvider]);

  return (
    <DataContext.Provider value={value}>
      <JotaiProvider store={jotaiStore}>{children}</JotaiProvider>
    </DataContext.Provider>
  );
};

export function useDataContext(): DataContextValue {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error("useDataContext must be used within a DataProvider");
  }
  return context;
}
