import { useMemo, useSyncExternalStore } from "react";

import {
  VehicleCatalogError,
  type VehicleCatalog,
} from "@/cp/domain/vehicle/VehicleCatalog";
import { OpenEvDirectoryClient } from "@/cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";
import { useServerInfo } from "@/data/hooks/useServerInfo";
import { useDataContext } from "@/data/providers/DataProvider";

import { describeError } from "../pages/cp/connectorActions";

/**
 * Which vehicle catalog the console imports from (#458), and with which key.
 *
 * Remote mode: the daemon's. The console never sees the key; `server.info`
 * says whether one is set.
 *
 * Local mode: the console calls Open EV Directory itself with a key the user
 * typed. That key is held **in memory only** — never in localStorage,
 * IndexedDB, an export or a URL — so it is gone when the tab closes. The base
 * URL is not a secret and is remembered in localStorage.
 */

/** Where to get a personal key; the self-service page is not live yet. */
export const OED_KEY_HELP_URL = "https://github.com/juherr/open-ev-directory";

export const OED_BASE_URL_STORAGE_KEY = "ocpp-cp.oed-base-url";

interface LocalCredentials {
  baseUrl: string;
  apiKey: string | null;
}

const listeners = new Set<() => void>();
let credentials: LocalCredentials | null = null;

function readCredentials(): LocalCredentials {
  if (!credentials) {
    let baseUrl = "";
    try {
      baseUrl = window.localStorage.getItem(OED_BASE_URL_STORAGE_KEY) ?? "";
    } catch {
      // Storage disabled: the URL is asked for each session.
    }
    credentials = { baseUrl, apiKey: null };
  }
  return credentials;
}

function setCredentials(next: LocalCredentials): void {
  credentials = next;
  try {
    if (next.baseUrl) {
      window.localStorage.setItem(OED_BASE_URL_STORAGE_KEY, next.baseUrl);
    } else {
      window.localStorage.removeItem(OED_BASE_URL_STORAGE_KEY);
    }
  } catch {
    // Storage disabled: kept for this session only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the session's key and URL. */
export function resetLocalCatalogCredentialsForTests(): void {
  credentials = null;
}

export type CatalogAccess =
  | {
      mode: "remote";
      catalog: VehicleCatalog | null;
      /** null while `server.info` loads, or on a daemon that predates #458. */
      configured: boolean | null;
      authenticated: boolean | null;
    }
  | {
      mode: "local";
      catalog: VehicleCatalog | null;
      baseUrl: string;
      baseUrlError: string | null;
      hasKey: boolean;
      setBaseUrl(url: string): void;
      /** `null` forgets the key. */
      setApiKey(key: string | null): void;
    };

export function useVehicleCatalog(): CatalogAccess {
  const { mode, chargePointService } = useDataContext();
  const info = useServerInfo();
  const local = useSyncExternalStore(subscribe, readCredentials);

  const localClient = useMemo(() => {
    if (!local.baseUrl.trim()) return { catalog: null, error: null };
    try {
      return {
        catalog: new OpenEvDirectoryClient({
          baseUrl: local.baseUrl,
          apiKey: local.apiKey ?? undefined,
        }),
        error: null,
      };
    } catch (error) {
      return {
        catalog: null,
        error: describeError(error),
      };
    }
  }, [local.baseUrl, local.apiKey]);

  const remoteCatalog = useMemo(() => {
    const catalog = chargePointService.getVehicleCatalog?.();
    // A service without the method, or a test double answering anything, is
    // no catalog.
    return catalog && typeof catalog.getVariant === "function" ? catalog : null;
  }, [chargePointService]);

  if (mode === "remote") {
    const status = info?.vehicleCatalog;
    return {
      mode: "remote",
      catalog: status?.configured === false ? null : remoteCatalog,
      configured: status ? status.configured : null,
      authenticated: status ? status.authenticated : null,
    };
  }
  return {
    mode: "local",
    catalog: localClient.catalog,
    baseUrl: local.baseUrl,
    baseUrlError: localClient.error,
    hasKey: local.apiKey !== null,
    setBaseUrl: (url) =>
      setCredentials({ ...readCredentials(), baseUrl: url.trim() }),
    setApiKey: (key) =>
      setCredentials({
        ...readCredentials(),
        apiKey: key && key.trim() ? key.trim() : null,
      }),
  };
}

/** A catalog failure in words the user can act on. Never contains the key. */
export function describeCatalogError(
  error: unknown,
  mode: "local" | "remote",
): string {
  if (!(error instanceof VehicleCatalogError)) {
    return describeError(error);
  }
  switch (error.kind) {
    case "unauthorized":
      return mode === "local"
        ? "Open EV Directory refused the API key: it is missing, invalid, expired or revoked. Enter your personal key."
        : "Open EV Directory refused the daemon's API key: it is missing, invalid, expired or revoked. Set OED_API_KEY on the daemon.";
    case "rate_limited":
      return error.retryAfterSeconds !== undefined
        ? `Open EV Directory's rate limit is reached; try again in ${error.retryAfterSeconds} s.`
        : "Open EV Directory's rate limit is reached; try again later.";
    case "network":
      return mode === "local"
        ? "Open EV Directory could not be reached. You may be offline, or the API does not allow calls from this page (CORS): import through the daemon instead (start it with --oed-base-url and OED_API_KEY)."
        : `Open EV Directory could not be reached: ${error.message}`;
    case "timeout":
      return "Open EV Directory did not answer in time; try again.";
    case "not_found":
      return `Not found in Open EV Directory: ${error.message}`;
    case "not_configured":
      return catalogNotConfiguredMessage(mode);
    default:
      return error.message;
  }
}

/** Why there is no catalog to call, and how to get one. */
export function catalogNotConfiguredMessage(mode: "local" | "remote"): string {
  return mode === "local"
    ? "Enter the Open EV Directory URL first."
    : "The daemon has no Open EV Directory URL; start it with --oed-base-url or OED_BASE_URL.";
}
