import React, { useId, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  History,
  PanelLeftClose,
  PanelLeftOpen,
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

const SIDEBAR_COLLAPSED_KEY = "ocpp-cp.console.sidebar.collapsed";

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // storage unavailable (private window): the state just isn't kept
  }
}

const AppShell: React.FC = () => {
  const location = useLocation();
  const { mode, serverUrl } = useDataContext();
  const serverInfo = useServerInfo();
  const health = useRemoteHealth();
  const isRemote = mode === "remote";
  const navId = useId();
  // Collapsed, the sidebar is an icon rail: the labels become tooltips and
  // the server URL and version line are dropped.
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    storeCollapsed(next);
  };

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    // Mounted here (the layout route wrapping every console page's
    // <Outlet/>) rather than inside DashboardPage/LogsPage individually, so
    // the log ring buffer survives navigation between routes instead of
    // resetting each time a page mounts a fresh instance.
    <GlobalLogsProvider>
      <div className="flex h-screen">
        <aside
          data-collapsed={collapsed ? "true" : "false"}
          className={cn(
            "flex shrink-0 flex-col border-r border-cx-border bg-cx-side transition-[width] duration-150",
            collapsed ? "w-[52px]" : "w-[220px]",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 py-4",
              collapsed ? "flex-col px-2" : "px-4",
            )}
          >
            <Zap className="h-6 w-6 shrink-0 text-cx-accent" />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-tight">
                  CP Simulator
                </div>
                <div className="font-mono text-[11px] leading-tight text-cx-faint">
                  OCPP 1.2–2.1
                </div>
              </div>
            )}
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls={navId}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleCollapsed}
              className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-cx-muted hover:bg-cx-sub hover:text-cx-fg"
            >
              <ToggleIcon className="h-4 w-4" />
            </button>
          </div>

          <nav id={navId} className="flex-1 space-y-1 px-2">
            {NAV_ITEMS.map(({ label, to, icon: Icon, isActive }) => {
              const active = isActive(location.pathname);
              return (
                <Link
                  key={label}
                  to={to}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? label : undefined}
                  title={collapsed ? label : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-[7px] py-1.5 text-[13.5px] font-medium text-cx-muted hover:text-cx-fg",
                    collapsed ? "justify-center px-0" : "px-2.5",
                    active && "bg-cx-sub text-cx-fg",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active && "text-cx-accent",
                    )}
                  />
                  {!collapsed && label}
                </Link>
              );
            })}
          </nav>

          <div
            className={cn(
              "space-y-2 border-t border-cx-border text-[11.5px] text-cx-faint",
              collapsed ? "px-1 py-3" : "p-3",
            )}
          >
            <div
              className={cn(
                "flex items-center",
                collapsed ? "flex-col gap-2" : "justify-between",
              )}
            >
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
                <span className={cn(collapsed && "sr-only")}>
                  {isRemote ? "Remote mode" : "Local mode"}
                </span>
              </span>
              <ThemeToggle />
            </div>
            {!collapsed && (
              <>
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
              </>
            )}
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
