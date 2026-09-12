import { useEffect, useState } from "react";

import type { ServerInfo } from "../../protocol";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { useDataContext } from "../providers/DataProvider";
import type { RemoteConnectionState } from "../remote/RemoteChargePointService";

/**
 * `server.info` is fixed for one daemon run, and the pages that need it are
 * exclusive routes, so one fetch per connection is enough: a later mount
 * resolves from the cache instead of flashing "no public base" until the
 * round trip lands. The cache is dropped when the connection comes back —
 * the console may have reconnected to a restarted daemon whose tunnel URL
 * differs (free-tier ngrok) — and on failure, so the next connection retries.
 */
const cache = new WeakMap<ChargePointService, Promise<ServerInfo | null>>();

interface ConnectionAwareService {
  onConnectionChange(
    handler: (state: RemoteConnectionState) => void,
  ): () => void;
}

function isConnectionAwareService(
  service: unknown,
): service is ConnectionAwareService {
  return (
    typeof service === "object" &&
    service !== null &&
    "onConnectionChange" in service &&
    typeof (service as { onConnectionChange?: unknown }).onConnectionChange ===
      "function"
  );
}

function loadServerInfo(
  service: ChargePointService,
): Promise<ServerInfo | null> {
  const load = service.getServerInfo?.bind(service);
  if (!load) return Promise.resolve(null);
  let pending = cache.get(service);
  if (!pending) {
    pending = load().then(
      (value) => value ?? null,
      (error: unknown) => {
        console.error("Failed to load server info", error);
        cache.delete(service);
        return null;
      },
    );
    cache.set(service, pending);
  }
  return pending;
}

/**
 * The daemon's `server.info`. Null in local mode, on a daemon that predates
 * the method, or while loading — callers treat every one of those the same
 * way: no public base to derive from.
 */
export function useServerInfo(): ServerInfo | null {
  const { chargePointService } = useDataContext();
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void loadServerInfo(chargePointService).then((value) => {
        if (!cancelled) setInfo(value);
      });
    };
    if (!isConnectionAwareService(chargePointService)) {
      refresh();
      return () => {
        cancelled = true;
      };
    }
    // The subscription replays the current state, so the first "connected"
    // is also the initial fetch; every later one is a fresh connection whose
    // daemon may not be the one the cache describes.
    let replay = true;
    let wasConnected = false;
    const unsubscribe = chargePointService.onConnectionChange((state) => {
      const connected = state === "connected";
      const reconnected = connected && !wasConnected && !replay;
      wasConnected = connected;
      replay = false;
      if (reconnected) cache.delete(chargePointService);
      if (connected) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chargePointService]);

  return info;
}
