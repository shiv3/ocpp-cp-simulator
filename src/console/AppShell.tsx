import React from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  History,
  PlugZap,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDataContext } from "../data/providers/DataProvider";
import { useServerInfo } from "../data/hooks/useServerInfo";
import {
  REMOTE_HEALTH_TEXT,
  useRemoteHealth,
  type RemoteHealth,
} from "../data/hooks/useRemoteHealth";
import ThemeToggle from "../components/ThemeToggle";
import AppBuildInfo from "../components/AppBuildInfo";
import { GlobalLogsProvider } from "./lib/GlobalLogsProvider";

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
}

// "Charge Points" is the home screen (there's no separate Dashboard route —
// the console root lists the charge points), and it also stays lit while the
// operator is drilled into a specific CP at `/cp/:cpId`.
const NAV_ITEMS: NavItem[] = [
  {
    label: "Charge Points",
    to: "/",
    icon: PlugZap,
    isActive: (pathname) => pathname === "/" || pathname.startsWith("/cp/"),
  },
  {
    label: "Scenarios",
    to: "/scenarios",
    icon: Play,
    isActive: (pathname) =>
      pathname.startsWith("/scenarios") &&
      !pathname.startsWith("/scenarios/runs"),
  },
  {
    label: "Run History",
    to: "/scenarios/runs",
    icon: History,
    isActive: (pathname) => pathname.startsWith("/scenarios/runs"),
  },
  {
    label: "Message Log",
    to: "/logs",
    icon: ScrollText,
    isActive: (pathname) => pathname.startsWith("/logs"),
  },
  {
    label: "Settings",
    to: "/settings",
    icon: SettingsIcon,
    isActive: (pathname) => pathname.startsWith("/settings"),
  },
];

const HEALTH_DOT: Record<RemoteHealth, string> = {
  checking: "bg-amber-400 animate-pulse",
  ok: "bg-emerald-500",
  down: "bg-red-500 animate-pulse",
};

const AppShell: React.FC = () => {
  const location = useLocation();
  const { mode, serverUrl } = useDataContext();
  const serverInfo = useServerInfo();
  const health = useRemoteHealth();
  const isRemote = mode === "remote";

  return (
    // Mounted here (the layout route wrapping every console page's
    // <Outlet/>) rather than inside DashboardPage/LogsPage individually, so
    // the log ring buffer survives navigation between routes instead of
    // resetting each time a page mounts a fresh instance.
    <GlobalLogsProvider>
      <div className="flex h-screen">
        <aside className="w-60 shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
          <div className="flex items-center gap-2 px-4 py-4">
            <Zap className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            <div>
              <div className="text-sm font-semibold leading-tight">
                CP Simulator
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 leading-tight">
                OCPP 1.2–2.1
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-2">
            {NAV_ITEMS.map(({ label, to, icon: Icon, isActive }) => {
              const active = isActive(location.pathname);
              return (
                <Link
                  key={label}
                  to={to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
                    active &&
                      "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 rounded-lg",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="space-y-2 border-t border-gray-200 p-3 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <span
                data-testid="mode-indicator"
                title={
                  isRemote
                    ? `${serverUrl} — ${REMOTE_HEALTH_TEXT[health].reason}`
                    : "Local mode: the simulator runs in this browser"
                }
                className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300"
              >
                {/* Remote: the daemon connection (#423). Local mode has no
                    daemon, so its dot carries no status. */}
                {isRemote ? (
                  <span
                    role="status"
                    aria-label={REMOTE_HEALTH_TEXT[health].aria}
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      HEALTH_DOT[health],
                    )}
                  />
                ) : (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                  />
                )}
                {isRemote ? "Remote mode" : "Local mode"}
              </span>
              <ThemeToggle />
            </div>
            <div
              className="truncate font-mono text-xs text-gray-500 dark:text-gray-400"
              title={serverUrl}
            >
              {serverUrl}
            </div>
            {/* Build and daemon version line (issue #364). */}
            <AppBuildInfo
              className="flex-wrap"
              daemonVersion={serverInfo?.version}
            />
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900">
          <Outlet />
        </main>
      </div>
    </GlobalLogsProvider>
  );
};

export default AppShell;
