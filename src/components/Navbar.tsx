// components/Navbar.tsx
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ThemeToggle from "./ThemeToggle.tsx";
import { useDataContext } from "../data/providers/DataProvider";

type RemoteHealth = "checking" | "ok" | "down";

const HEALTH_POLL_MS = 5000;

const Navbar: React.FC = () => {
  const { mode, serverUrl, chargePointService } = useDataContext();
  const isRemote = mode === "remote";
  const [health, setHealth] = useState<RemoteHealth>("checking");

  // Poll the daemon's /healthz every 5s while we're in remote mode. Local
  // mode has no remote to watch, so skip the timer entirely.
  useEffect(() => {
    if (!isRemote || !chargePointService.ping) {
      setHealth("checking");
      return;
    }
    let cancelled = false;
    const ping = chargePointService.ping.bind(chargePointService);
    const tick = async () => {
      try {
        await ping();
        if (!cancelled) setHealth("ok");
      } catch {
        if (!cancelled) setHealth("down");
      }
    };
    void tick();
    const id = window.setInterval(tick, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
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
    : "bg-white/20 hover:bg-white/30";

  return (
    <nav className="bg-blue-600 dark:bg-gray-800 text-white shadow-lg transition-colors">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <Link
              className="text-xl font-bold hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
              to="/"
            >
              OCPP ChargePoint Simulator
            </Link>
            <Link
              to="/settings"
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
                  to="/"
                >
                  ChargePoint
                </Link>
              </li>
              <li>
                <Link
                  className="hover:text-blue-200 dark:hover:text-blue-400 transition-colors"
                  to="/settings"
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
