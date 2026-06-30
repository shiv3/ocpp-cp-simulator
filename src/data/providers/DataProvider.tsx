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

import type { RuntimeMode } from "../RuntimeMode";
import { HEALTH_PATH } from "../healthPath";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { LocalChargePointService } from "../local/LocalChargePointService";
import { RemoteChargePointService } from "../remote/RemoteChargePointService";
import type { Database } from "../../cp/domain/persistence/Database";
// SqlJsDatabase intentionally NOT imported eagerly — see the mode-gated
// dynamic import below. Remote mode never needs it, so we keep the
// ~650 KB WASM wrapper out of that path entirely.
import {
  type EVSettings,
  defaultEVSettings,
  setUserDefaultEVSettings,
} from "../../cp/domain/connector/EVSettings";

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

interface DataContextValue {
  /** Current runtime mode — auto-detected from the page origin's health
   *  probe (see HEALTH_PATH; default `/v1/healthz`), no manual toggle.
   *  `remote` when served by the daemon's --web-console; `local` for
   *  static builds. */
  mode: RuntimeMode;
  serverUrl: string;
  /** Browser-side user-configured default EV settings.
   *  `null` means "no override — fall back to the built-in defaults". */
  defaultEvSettings: EVSettings | null;
  setDefaultEvSettings: (s: EVSettings | null) => void;
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
  // Mode resolution. We never assume a mode at first render — `mode` is
  // null until the health probe tells us whether we're local or remote. That gate
  // is important because we only spin up sql.js (~650 KB WASM + IndexedDB
  // read) for the local path; remote mode talks to the daemon's own
  // SQLite via the API and has no use for a browser-side store.
  const initialMode = useMemo<RuntimeMode | null>(() => {
    if (modeOverride) return modeOverride;
    return null;
  }, [modeOverride]);

  // Server URL: prefer the explicit prop, else the current page origin.
  // The legacy localStorage value is intentionally ignored — Remote mode is
  // only entered through origin auto-detection, which sets the URL to the
  // origin that successfully answered the health probe (HEALTH_PATH).
  const initialServerUrl = useMemo<string>(() => {
    if (serverUrlOverride) return serverUrlOverride;
    if (typeof window !== "undefined") return window.location.origin;
    return DEFAULT_SERVER_URL;
  }, [serverUrlOverride]);

  const [mode, setModeState] = useState<RuntimeMode | null>(initialMode);
  const [serverUrl, setServerUrlState] = useState<string>(initialServerUrl);
  const [defaultEvSettings, setDefaultEvSettingsState] =
    useState<EVSettings | null>(() => loadDefaultEvFromStorage());

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

  // Origin-based mode detection: the only way the UI ever enters Remote
  // mode. If HEALTH_PATH at the current origin answers ok, the UI was served
  // by `ocpp-cp-sim --web-console` (or the Docker image) and we point the
  // RemoteChargePointService at that same origin. Otherwise we stay Local
  // — true for static builds (GitHub Pages, `bun run dev`, Tauri). No
  // persistence: dropping the daemon flips back to Local on next reload.
  useEffect(() => {
    if (modeOverride) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    const origin = window.location.origin;
    fetch(`${origin}${HEALTH_PATH}`, { method: "GET", cache: "no-store" })
      .then(async (res) => {
        // `fetch` does NOT reject on HTTP error status — a 404 (e.g. when
        // the UI is served from GitHub Pages where no health endpoint
        // exists) resolves with res.ok=false. Treat any non-2xx as
        // "no daemon here → Local" so we don't sit in the null-mode
        // initialization gate forever.
        if (!res.ok) return null;
        try {
          return (await res.json()) as unknown;
        } catch {
          return null;
        }
      })
      .then((body) => {
        if (cancelled) return;
        if (
          body &&
          typeof body === "object" &&
          "ok" in body &&
          (body as { ok?: unknown }).ok === true
        ) {
          setModeState("remote");
          setServerUrlState(origin);
        } else {
          setModeState("local");
        }
      })
      .catch(() => {
        // Network error (CORS, offline, DNS, …) — also Local.
        if (!cancelled) setModeState("local");
      });

    return () => {
      cancelled = true;
    };
  }, [modeOverride]);

  const jotaiStore = useMemo(() => createStore(), []);

  // sql.js takes a moment to load (WASM fetch + parse + IndexedDB read),
  // so we only open it when we KNOW we're in local mode — remote mode
  // has nothing to store locally (the daemon owns persistence).
  const [database, setDatabase] = useState<Database | null>(null);
  const [dbReady, setDbReady] = useState(false);
  useEffect(() => {
    if (mode !== "local") {
      setDatabase(null);
      setDbReady(true);
      return;
    }
    setDbReady(false);
    let cancelled = false;
    let opened: Database | null = null;
    // Dynamic import keeps sql.js (~650 KB WASM + JS glue) out of the
    // remote-mode bundle; vite splits this into its own chunk.
    void import("../sqlite/SqlJsDatabase")
      .then(({ SqlJsDatabase }) => SqlJsDatabase.create())
      .then((db) => {
        if (cancelled) {
          db.close();
          return;
        }
        opened = db;
        setDatabase(db);
        setDbReady(true);
      })
      .catch((err) => {
        console.error("Failed to initialise SQLite database", err);
        setDbReady(true); // unblock the UI even if persistence is broken
      });
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [mode]);

  const localChargePointService = useMemo(
    () => new LocalChargePointService(database),
    [database],
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

  // Keep already-live connectors in sync with the Default EV Settings. They
  // freeze getDefaultEVSettings() at construction, so a mid-session change
  // would otherwise only take effect after a page reload (#107). Firing on
  // mount too is a harmless no-op: fresh connectors already hold the default.
  useEffect(() => {
    if (!defaultEvSettings) return;
    void chargePointService
      .applyDefaultEVSettings(defaultEvSettings)
      .catch((err) =>
        console.error("Failed to apply default EV settings", err),
      );
  }, [defaultEvSettings, chargePointService]);

  // Wait for mode resolution (so we don't render local UI just to swap to
  // remote a moment later) AND for the DB to be ready in local mode. In
  // remote mode `dbReady` flips immediately because there's no DB to wait on.
  const ready = mode !== null && dbReady;

  const value = useMemo(
    () =>
      ready
        ? {
            mode: mode as RuntimeMode,
            serverUrl,
            defaultEvSettings,
            setDefaultEvSettings,
            chargePointService,
          }
        : null,
    [ready, mode, serverUrl, defaultEvSettings, chargePointService],
  );

  if (!ready || !value) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

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
