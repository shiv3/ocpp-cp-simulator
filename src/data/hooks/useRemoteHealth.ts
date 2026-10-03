import { useEffect, useState } from "react";

import { useDataContext } from "../providers/DataProvider";
import type { RemoteConnectionState } from "../remote/RemoteChargePointService";

/** The daemon connection as the UI shows it. */
export type RemoteHealth = "checking" | "ok" | "down";

interface ConnectionAwareService {
  getConnectionState(): RemoteConnectionState;
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
    "getConnectionState" in service &&
    "onConnectionChange" in service &&
    typeof (service as { getConnectionState?: unknown }).getConnectionState ===
      "function" &&
    typeof (service as { onConnectionChange?: unknown }).onConnectionChange ===
      "function"
  );
}

function healthFromConnectionState(state: RemoteConnectionState): RemoteHealth {
  if (state === "connected") return "ok";
  if (state === "connecting") return "checking";
  return "down";
}

/**
 * Remote mode: the state of the connection to the daemon, live. `checking`
 * in Local mode (there is no daemon) and with a service that does not report
 * its connection.
 */
export function useRemoteHealth(): RemoteHealth {
  const { mode, serverUrl, chargePointService } = useDataContext();
  const isRemote = mode === "remote";
  const [health, setHealth] = useState<RemoteHealth>("checking");

  useEffect(() => {
    if (!isRemote || !isConnectionAwareService(chargePointService)) {
      setHealth("checking");
      return;
    }
    setHealth(
      healthFromConnectionState(chargePointService.getConnectionState()),
    );
    return chargePointService.onConnectionChange((state) => {
      setHealth(healthFromConnectionState(state));
    });
  }, [isRemote, serverUrl, chargePointService]);

  return health;
}

/** Screen-reader label and tooltip reason for each state. */
export const REMOTE_HEALTH_TEXT: Record<
  RemoteHealth,
  { aria: string; reason: string }
> = {
  checking: { aria: "Remote connection: checking", reason: "Checking…" },
  ok: { aria: "Remote connection: connected", reason: "Connected" },
  down: {
    aria: "Remote connection: disconnected",
    reason: "Cannot reach the daemon",
  },
};
