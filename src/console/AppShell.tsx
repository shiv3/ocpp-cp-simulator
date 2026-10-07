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
  checking: "bg-cx-amber animate-pulse",
  ok: "bg-cx-emerald",
  down: "bg-cx-rose animate-pulse",
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
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-cx-border bg-cx-side">
          <div className="flex items-center gap-2 px-4 py-4">
            <Zap className="h-6 w-6 text-cx-accent" />
            <div>
              <div className="text-sm font-semibold leading-tight">
                CP Simulator
              </div>
              <div className="font-mono text-[11px] leading-tight text-cx-faint">
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
                    "flex items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[13.5px] font-medium text-cx-muted hover:text-cx-fg",
                    active && "bg-cx-sub text-cx-fg",
                  )}
                >
                  <Icon className={cn("h-4 w-4", active && "text-cx-accent")} />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="space-y-2 border-t border-cx-border p-3 text-[11.5px] text-cx-faint">
            <div className="flex items-center justify-between">
              <span
                data-testid="mode-indicator"
                title={
                  isRemote
                    ? `${serverUrl} — ${REMOTE_HEALTH_TEXT[health].reason}`
                    : "Local mode: the simulator runs in this browser"
                }
                className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-cx-fg2"
              >
                {/* Remote: the daemon connection (#423). Local mode has no
                    daemon, so its dot carries no status. */}
                {isRemote ? (
                  <span
                    role="status"
                    aria-label={REMOTE_HEALTH_TEXT[health].aria}
                    className={cn(
                      "h-[7px] w-[7px] rounded-full",
                      HEALTH_DOT[health],
                    )}
                  />
                ) : (
                  <span
                    aria-hidden
                    className="h-[7px] w-[7px] rounded-full bg-cx-emerald"
                  />
                )}
                {isRemote ? "Remote mode" : "Local mode"}
              </span>
              <ThemeToggle />
            </div>
            <div
              className="truncate font-mono text-[11.5px] text-cx-faint"
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

        {/* data-console-main: src/index.css gives it a right margin while a
            side panel is open, so the page is not hidden under the panel. */}
        <main data-console-main className="flex-1 overflow-y-auto bg-cx-bg">
          <Outlet />
        </main>
      </div>
    </GlobalLogsProvider>
  );
};

export default AppShell;
