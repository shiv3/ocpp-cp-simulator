// components/Navbar.tsx
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ThemeToggle from "./ThemeToggle.tsx";
import { useDataContext } from "../data/providers/DataProvider";
import type { RemoteConnectionState } from "../data/remote/RemoteChargePointService";

type RemoteHealth = "checking" | "ok" | "down";

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

const Navbar: React.FC = () => {
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

  const badgeLabel = isRemote
    ? `Remote · ${serverUrl.replace(/^https?:\/\//, "")}`
    : "Local";
  const healthMeta: Record<
    RemoteHealth,
    { dot: string; aria: string; reason: string }
  > = {
    checking: {
      dot: "bg-yellow-400 animate-pulse",
      aria: "Remote connection: checking",
      reason: "Checking…",
    },
    ok: {
      dot: "bg-emerald-400",
      aria: "Remote connection: connected",
      reason: "Connected",
    },
    down: {
      dot: "bg-red-500 animate-pulse",
      aria: "Remote connection: disconnected",
      reason: "Cannot reach the daemon",
    },
  };
  const badgeTitle = isRemote
    ? `Remote · ${serverUrl} — ${healthMeta[health].reason} — click to change`
    : "Local — click to change";
  const badgeBg = isRemote
    ? health === "down"
      ? "bg-red-500/30 text-red-100 hover:bg-red-500/50"
      : "bg-emerald-500/30 text-emerald-100 hover:bg-emerald-500/50"
    : "bg-white/95 text-blue-700 hover:bg-white dark:bg-white/15 dark:text-white dark:hover:bg-white/25";

  return (
    <nav className="bg-blue-600 dark:bg-gray-800 text-white shadow-lg transition-colors">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <Link
              className="text-xl font-bold hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
              to="/v2"
            >
              OCPP ChargePoint Simulator
            </Link>
            <Link
              to="/v2/settings"
              title={badgeTitle}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded transition-colors ${badgeBg}`}
            >
              {isRemote ? (
                <span
                  aria-label={healthMeta[health].aria}
                  role="status"
                  className={`inline-block w-2 h-2 rounded-full ${healthMeta[health].dot}`}
                />
              ) : null}
              <span>{badgeLabel}</span>
            </Link>
          </div>
          <div className="flex items-center space-x-4">
            <ul className="flex space-x-4">
              <li>
                <Link
                  className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
                  to="/v2"
                >
                  ChargePoint
                </Link>
              </li>
              <li>
                <Link
                  className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
                  to="/v2/settings"
                >
                  Settings
                </Link>
              </li>
            </ul>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
