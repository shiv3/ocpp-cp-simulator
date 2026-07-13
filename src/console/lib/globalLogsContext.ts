import { createContext } from "react";

import type { LogEntry } from "../../cp/shared/Logger";

/** One aggregated log line: which CP it came from, the raw entry, and a
 *  monotonic append-order counter used as a stable React key (timestamps
 *  alone can collide when several entries land in the same millisecond). */
export interface GlobalLogEntry {
  cpId: string;
  entry: LogEntry;
  seq: number;
}

export interface UseGlobalLogsResult {
  /** Newest first. */
  entries: GlobalLogEntry[];
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clear: () => void;
}

/** Populated by `<GlobalLogsProvider>` (see `./GlobalLogsProvider.tsx`) —
 *  `null` outside one. Not intended to be read directly by page code; go
 *  through `useGlobalLogs()` (`./useGlobalLogs.ts`) so the "must be mounted
 *  under a provider" error is centralized. Kept in its own module (rather
 *  than alongside the `GlobalLogsProvider` component) so that file only
 *  exports a component, per the project's react-refresh lint rule. */
export const GlobalLogsContext = createContext<UseGlobalLogsResult | null>(
  null,
);
