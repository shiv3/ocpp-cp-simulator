import { useEffect, useState } from "react";

import type { ServerInfo } from "../../protocol";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { useDataContext } from "../providers/DataProvider";
import type { RemoteConnectionState } from "../remote/RemoteChargePointService";

/**
 * `server.info` is fixed for one daemon run, so one fetch per connection is
 * enough, shared by every component that reads it: a later mount resolves
 * from the cache instead of flashing "no public base" until the round trip
 * lands. The cache is dropped when the connection comes back — the console
 * may have reconnected to a restarted daemon whose tunnel URL differs
 * (free-tier ngrok) — and on failure, so the next connection retries.
 */
const cache = new WeakMap<ChargePointService, Promise<ServerInfo | null>>();

/** Services whose reconnects already drop the cache (see watchReconnects). */
const watched = new WeakSet<ChargePointService>();

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
 * Drops the service's cache on each reconnect, once per service rather than
 * once per hook: always-mounted readers (the version line, #364) sit beside
 * the pages that read it, and a per-hook drop would let each one discard the
 * fetch the previous handler just started — one RPC per reader per reconnect.
 * Subscribed before any hook's own handler, so the cache is already dropped
 * when the hooks refresh. It lives as long as the service does.
 */
function watchReconnects(
  service: ChargePointService & ConnectionAwareService,
): void {
  if (watched.has(service)) return;
  watched.add(service);
  // The subscription replays the current state, so the first "connected" is
  // the initial connection, not a reconnect.
  let replay = true;
  let wasConnected = false;
  service.onConnectionChange((state) => {
    const connected = state === "connected";
    if (connected && !wasConnected && !replay) cache.delete(service);
    wasConnected = connected;
    replay = false;
  });
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
    watchReconnects(chargePointService);
    // The replayed "connected" is the initial fetch; a later one reads the
    // cache watchReconnects has just dropped, so it fetches the new daemon's.
    const unsubscribe = chargePointService.onConnectionChange((state) => {
      if (state === "connected") refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chargePointService]);

  return info;
}
