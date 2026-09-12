import { useEffect, useState } from "react";

import type { ServerInfo } from "../../protocol";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { useDataContext } from "../providers/DataProvider";

/**
 * `server.info` is fixed for the daemon's lifetime, and the pages that need
 * it are exclusive routes, so one fetch per service instance is enough: a
 * later mount resolves from the cache instead of flashing "no public base"
 * until the round trip lands.
 */
const cache = new WeakMap<ChargePointService, Promise<ServerInfo | null>>();

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
    void loadServerInfo(chargePointService).then((value) => {
      if (!cancelled) setInfo(value);
    });
    return () => {
      cancelled = true;
    };
  }, [chargePointService]);

  return info;
}
