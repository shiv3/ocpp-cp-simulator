import React from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  PlugZap,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  SquarePen,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDataContext } from "../data/providers/DataProvider";
import ThemeToggle from "../components/ThemeToggle";
import { GlobalLogsProvider } from "./lib/GlobalLogsProvider";
import { consolePath } from "./routes";

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
}

// The console is mounted under `/v3`, so links go through `consolePath()` and
// `isActive` matches against the `/v3`-prefixed pathname.
//
// "Charge Points" is the home screen (there's no separate Dashboard route —
// the console root lists the charge points), and it also stays lit while the
// operator is drilled into a specific CP at `/cp/:cpId`.
const NAV_ITEMS: NavItem[] = [
  {
    label: "Charge Points",
    to: consolePath("/"),
    icon: PlugZap,
    isActive: (pathname) =>
      pathname === consolePath("/") || pathname.startsWith(consolePath("/cp/")),
  },
  {
    label: "Scenarios",
    to: consolePath("/scenarios"),
    icon: Play,
    isActive: (pathname) => pathname.startsWith(consolePath("/scenarios")),
  },
  {
    label: "Message Log",
    to: consolePath("/logs"),
    icon: ScrollText,
    isActive: (pathname) => pathname.startsWith(consolePath("/logs")),
  },
  {
    label: "Settings",
    to: consolePath("/settings"),
    icon: SettingsIcon,
    isActive: (pathname) => pathname.startsWith(consolePath("/settings")),
  },
];

const AppShell: React.FC = () => {
  const location = useLocation();
  const { mode, serverUrl } = useDataContext();
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
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {isRemote ? "Remote mode" : "Local mode"}
              </span>
              <ThemeToggle />
            </div>
            {/* Design switcher — mirrored on the classic UI's navbar so the
                operator can hop between the two designs from either side.
                The classic UI is served at the root. */}
            <Link
              to="/"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <SquarePen className="h-3.5 w-3.5" />
              Switch to classic design
            </Link>
            <div
              className="truncate font-mono text-xs text-gray-500 dark:text-gray-400"
              title={serverUrl}
            >
              {serverUrl}
            </div>
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
