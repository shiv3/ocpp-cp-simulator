import type { MessageKey } from "../../i18n";
import { useEffect, useState } from "react";

import { useDataContext } from "../providers/DataProvider";
import type { RemoteConnectionState } from "@ocpp-cp-sim/client/remote/RemoteChargePointService";

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

/** Screen-reader label and tooltip reason for each state, as message keys:
 *  translate at render time with `t(REMOTE_HEALTH_TEXT[health].aria)`. */
export const REMOTE_HEALTH_TEXT: Record<
  RemoteHealth,
  { aria: MessageKey; reason: MessageKey }
> = {
  checking: {
    aria: "common.health.checkingAria",
    reason: "common.health.checkingReason",
  },
  ok: { aria: "common.health.okAria", reason: "common.health.okReason" },
  down: {
    aria: "common.health.downAria",
    reason: "common.health.downReason",
  },
};
