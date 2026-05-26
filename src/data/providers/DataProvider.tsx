import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Provider as JotaiProvider } from "jotai";
import { createStore } from "jotai/vanilla";

import { resolveRuntimeMode, type RuntimeMode } from "../RuntimeMode";
import type { ConfigRepository } from "../interfaces/ConfigRepository";
import type { ScenarioRepository } from "../interfaces/ScenarioRepository";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { LocalConfigRepository } from "../local/LocalConfigRepository";
import { LocalScenarioRepository } from "../local/LocalScenarioRepository";
import { LocalConnectorSettingsRepository } from "../local/LocalConnectorSettingsRepository";
import { LocalChargePointService } from "../local/LocalChargePointService";
import { RemoteChargePointService } from "../remote/RemoteChargePointService";

const MODE_STORAGE_KEY = "ocpp-cp.runtime.mode";
const SERVER_URL_STORAGE_KEY = "ocpp-cp.runtime.serverUrl";
const DEFAULT_SERVER_URL = "http://127.0.0.1:9700";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best effort
  }
}

interface DataContextValue {
  mode: RuntimeMode;
  serverUrl: string;
  setMode: (mode: RuntimeMode) => void;
  setServerUrl: (url: string) => void;
  configRepository: ConfigRepository;
  scenarioRepository: ScenarioRepository;
  connectorSettingsRepository: ConnectorSettingsRepository;
  chargePointService: ChargePointService;
}

const DataContext = createContext<DataContextValue | null>(null);

interface DataProviderProps {
  children: ReactNode;
  modeOverride?: RuntimeMode;
  serverUrlOverride?: string;
}

export const DataProvider: React.FC<DataProviderProps> = ({
  children,
  modeOverride,
  serverUrlOverride,
}) => {
  const initialMode = useMemo<RuntimeMode>(() => {
    if (modeOverride) return modeOverride;
    const stored = readStorage(MODE_STORAGE_KEY);
    if (stored === "local" || stored === "remote") return stored;
    return resolveRuntimeMode();
  }, [modeOverride]);

  const initialServerUrl = useMemo<string>(() => {
    if (serverUrlOverride) return serverUrlOverride;
    return readStorage(SERVER_URL_STORAGE_KEY) ?? DEFAULT_SERVER_URL;
  }, [serverUrlOverride]);

  const [mode, setModeState] = useState<RuntimeMode>(initialMode);
  const [serverUrl, setServerUrlState] = useState<string>(initialServerUrl);

  const setMode = (next: RuntimeMode) => {
    setModeState(next);
    writeStorage(MODE_STORAGE_KEY, next);
  };

  const setServerUrl = (next: string) => {
    setServerUrlState(next);
    writeStorage(SERVER_URL_STORAGE_KEY, next);
  };

  const jotaiStore = useMemo(() => createStore(), []);

  const configRepository = useMemo<ConfigRepository>(
    () => new LocalConfigRepository(jotaiStore),
    [jotaiStore],
  );
  const scenarioRepository = useMemo<ScenarioRepository>(
    () => new LocalScenarioRepository(),
    [],
  );
  const connectorSettingsRepository = useMemo<ConnectorSettingsRepository>(
    () => new LocalConnectorSettingsRepository(),
    [],
  );
  const localChargePointService = useMemo(
    () => new LocalChargePointService(),
    [],
  );
  const remoteChargePointService = useMemo<RemoteChargePointService | null>(
    () => (mode === "remote" ? new RemoteChargePointService(serverUrl) : null),
    [mode, serverUrl],
  );
  useEffect(() => {
    return () => {
      remoteChargePointService?.dispose();
    };
  }, [remoteChargePointService]);

  // When the user flips to remote mode, drop any locally-registered charge
  // points so their CSMS WebSocket connections don't keep running unmonitored
  // in the background. Switching back to local will re-create them from config.
  useEffect(() => {
    if (mode === "remote") {
      void localChargePointService.syncLocalChargePoints([]).catch((err) => {
        console.error("Failed to release local charge points", err);
      });
    }
  }, [mode, localChargePointService]);

  const chargePointService: ChargePointService =
    remoteChargePointService ?? localChargePointService;

  const value = useMemo(
    () => ({
      mode,
      serverUrl,
      setMode,
      setServerUrl,
      configRepository,
      scenarioRepository,
      connectorSettingsRepository,
      chargePointService,
    }),
    [
      mode,
      serverUrl,
      configRepository,
      scenarioRepository,
      connectorSettingsRepository,
      chargePointService,
    ],
  );

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
