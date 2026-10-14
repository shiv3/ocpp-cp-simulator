// components/Navbar.tsx
import React from "react";
import { Link } from "react-router-dom";
import { SquarePen } from "lucide-react";
import ThemeToggle from "./ThemeToggle.tsx";
import { useDataContext } from "../data/providers/DataProvider";
import {
  REMOTE_HEALTH_TEXT,
  useRemoteHealth,
  type RemoteHealth,
} from "../data/hooks/useRemoteHealth";

const Navbar: React.FC = () => {
  const { mode, serverUrl } = useDataContext();
  const isRemote = mode === "remote";
  const health = useRemoteHealth();

  const badgeLabel = isRemote
    ? `Remote · ${serverUrl.replace(/^https?:\/\//, "")}`
    : "Local";
  const healthDot: Record<RemoteHealth, string> = {
    checking: "bg-yellow-400 animate-pulse",
    ok: "bg-emerald-400",
    down: "bg-red-500 animate-pulse",
  };
  const badgeTitle = isRemote
    ? `Remote · ${serverUrl} — ${REMOTE_HEALTH_TEXT[health].reason} — click to change`
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
                  aria-label={REMOTE_HEALTH_TEXT[health].aria}
                  role="status"
                  className={`inline-block w-2 h-2 rounded-full ${healthDot[health]}`}
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
            {/* The classic UI lives under /v2 (#411); the web console is the
                default UI at the root. Absolute links: this navbar is mounted
                under the /v2/* route. */}
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded border border-white/40 px-2 py-1 text-xs font-semibold transition-colors hover:bg-white/15"
            >
              <SquarePen className="h-3.5 w-3.5" />
              Web console
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
