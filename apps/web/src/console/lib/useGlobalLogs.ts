import { useContext } from "react";

import { GlobalLogsContext } from "./globalLogsContext";
import type { UseGlobalLogsResult } from "./globalLogsContext";

export type { GlobalLogEntry, UseGlobalLogsResult } from "./globalLogsContext";

/** HH:mm:ss in local time (HH:mm:ss.SSS with `milliseconds`) — the charge
 *  point page's compact log and its Operational events tab render timestamps
 *  with it.
 *  Deliberately hand-rolled instead of `toLocaleTimeString` so output
 *  doesn't depend on the runtime's ICU/locale data (dom tests included). */
export function formatLogTime(
  date: Date,
  { milliseconds = false }: { milliseconds?: boolean } = {},
): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return milliseconds ? `${time}.${pad(date.getMilliseconds(), 3)}` : time;
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
