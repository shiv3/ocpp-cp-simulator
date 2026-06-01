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
import {
  type EVSettings,
  defaultEVSettings,
  setUserDefaultEVSettings,
} from "../../cp/domain/connector/EVSettings";

const MODE_STORAGE_KEY = "ocpp-cp.runtime.mode";
const SERVER_URL_STORAGE_KEY = "ocpp-cp.runtime.serverUrl";
const DEFAULT_EV_STORAGE_KEY = "ocpp-cp.default-ev-settings";
const DEFAULT_SERVER_URL = "http://127.0.0.1:9700";

function loadDefaultEvFromStorage(): EVSettings | null {
  const raw = readStorage(DEFAULT_EV_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EVSettings>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.batteryCapacityKwh === "number"
    ) {
      return { ...defaultEVSettings, ...parsed };
    }
  } catch {
    // ignore
  }
  return null;
}

// Seed the in-memory user override before any Connector is constructed. The
// module-level effect runs once at import time so charge points created at
// app boot already see the user's preferred default.
if (typeof window !== "undefined") {
  const stored = loadDefaultEvFromStorage();
  if (stored) setUserDefaultEVSettings(stored);
}

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
  /** Browser-side user-configured default EV settings.
   *  `null` means "no override — fall back to the built-in defaults". */
  defaultEvSettings: EVSettings | null;
  setDefaultEvSettings: (s: EVSettings | null) => void;
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
  const [defaultEvSettings, setDefaultEvSettingsState] =
    useState<EVSettings | null>(() => loadDefaultEvFromStorage());

  const setMode = (next: RuntimeMode) => {
    setModeState(next);
    writeStorage(MODE_STORAGE_KEY, next);
  };

  const setServerUrl = (next: string) => {
    setServerUrlState(next);
    writeStorage(SERVER_URL_STORAGE_KEY, next);
  };

  const setDefaultEvSettings = (next: EVSettings | null) => {
    setDefaultEvSettingsState(next);
    setUserDefaultEVSettings(next);
    if (typeof window !== "undefined") {
      try {
        if (next) {
          window.localStorage.setItem(
            DEFAULT_EV_STORAGE_KEY,
            JSON.stringify(next),
          );
        } else {
          window.localStorage.removeItem(DEFAULT_EV_STORAGE_KEY);
        }
      } catch {
        // best effort
      }
    }
  };

  // Auto-detect "bundled daemon": when the UI is served from the same
  // origin as the daemon (Docker image), probing /healthz succeeds and we
  // default to Remote mode pointing at that origin. Skipped when the user
  // has already made an explicit choice (localStorage or prop override)
  // so we never clobber a deliberate setting. Result is NOT persisted —
  // it's a per-load fallback so dropping the daemon flips us back to Local
  // on the next reload, and an explicit toggle still wins.
  useEffect(() => {
    if (modeOverride) return;
    if (readStorage(MODE_STORAGE_KEY)) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    const origin = window.location.origin;
    fetch(`${origin}/healthz`, { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        if ("ok" in body && (body as { ok?: unknown }).ok === true) {
          setModeState("remote");
          setServerUrlState(origin);
        }
      })
      .catch(() => {
        // No daemon at this origin — stay Local.
      });

    return () => {
      cancelled = true;
    };
  }, [modeOverride]);

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
      defaultEvSettings,
      setDefaultEvSettings,
      configRepository,
      scenarioRepository,
      connectorSettingsRepository,
      chargePointService,
    }),
    [
      mode,
      serverUrl,
      defaultEvSettings,
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
