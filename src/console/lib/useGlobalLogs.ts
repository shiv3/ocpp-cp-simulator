import { useContext } from "react";

import { GlobalLogsContext } from "./globalLogsContext";
import type { UseGlobalLogsResult } from "./globalLogsContext";

export type { GlobalLogEntry, UseGlobalLogsResult } from "./globalLogsContext";

/** HH:mm:ss in local time — shared by LogsPage's row list and the
 *  Dashboard's "Recent activity" strip so both render timestamps the same
 *  way. Deliberately hand-rolled instead of `toLocaleTimeString` so output
 *  doesn't depend on the runtime's ICU/locale data (dom tests included). */
export function formatLogTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Reads the app-wide log ring buffer owned by `<GlobalLogsProvider>`
 * (mounted once in `AppShell`, above `<Outlet/>`, so it survives console
 * route changes — see that module's doc comment for why). Every consumer
 * shares the same `entries`/`paused` state; there is no more
 * per-component-local buffer.
 *
 * Throws if called outside a `<GlobalLogsProvider>`. In practice that's
 * always the case for console pages, since `AppShell` wraps every route.
 */
export function useGlobalLogs(): UseGlobalLogsResult {
  const ctx = useContext(GlobalLogsContext);
  if (!ctx) {
    throw new Error(
      "useGlobalLogs() must be used within a <GlobalLogsProvider> (mounted in AppShell).",
    );
  }
  return ctx;
}
