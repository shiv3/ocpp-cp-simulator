import { useEffect, useState } from "react";

import type { ServerInfo } from "../../protocol";
import { useDataContext } from "../providers/DataProvider";

/**
 * The daemon's `server.info`, fetched once per service. Null in local mode,
 * on a daemon that predates the method, or while loading — callers treat
 * every one of those the same way: no public base to derive from.
 */
export function useServerInfo(): ServerInfo | null {
  const { chargePointService } = useDataContext();
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    const load = chargePointService.getServerInfo?.bind(chargePointService);
    if (!load) return;
    load()
      .then((value) => {
        if (!cancelled) setInfo(value ?? null);
      })
      .catch((error: unknown) => {
        console.error("Failed to load server info", error);
      });
    return () => {
      cancelled = true;
    };
  }, [chargePointService]);

  return info;
}
