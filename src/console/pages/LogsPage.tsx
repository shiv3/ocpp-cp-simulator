import React, { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LogLevel, LogType } from "../../cp/shared/Logger";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import {
  formatLogTime,
  useGlobalLogs,
  type GlobalLogEntry,
} from "../lib/useGlobalLogs";

/** Maps `LogType` to the `.log-*` badge classes defined in
 *  `src/index.css`. `SCENARIO` and `SYSTEM` have no dedicated color there —
 *  fall back to `.log-general` rather than inventing new colors outside
 *  this task's scope. */
const LOG_TYPE_CLASS: Record<LogType, string> = {
  [LogType.WEBSOCKET]: "log-websocket",
  [LogType.OCPP]: "log-ocpp",
  [LogType.TRANSACTION]: "log-transaction",
  [LogType.HEARTBEAT]: "log-heartbeat",
  [LogType.METER_VALUE]: "log-meter-value",
  [LogType.STATUS]: "log-status",
  [LogType.CONFIGURATION]: "log-configuration",
  [LogType.DIAGNOSTICS]: "log-diagnostics",
  [LogType.SCENARIO]: "log-general",
  [LogType.GENERAL]: "log-general",
  [LogType.SYSTEM]: "log-general",
};

const LOG_LEVEL_CLASS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "log-level-debug",
  [LogLevel.INFO]: "log-level-info",
  [LogLevel.WARN]: "log-level-warn",
  [LogLevel.ERROR]: "log-level-error",
};

const LEVEL_OPTIONS: Array<{ value: LogLevel; label: string }> = [
  { value: LogLevel.DEBUG, label: "Debug+" },
  { value: LogLevel.INFO, label: "Info+" },
  { value: LogLevel.WARN, label: "Warn+" },
  { value: LogLevel.ERROR, label: "Error+" },
];

const SELECT_CLASS =
  "rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200";

/**
 * Pretty-prints the first `{...}` JSON substring found in `message`, if
 * any, leaving the surrounding prose untouched. Best-effort: any parse
 * failure (unbalanced braces, non-JSON content that merely looks bracketed,
 * …) falls back to the original message unchanged.
 */
function prettyPrintMessage(message: string): string {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return message;
  const candidate = message.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(candidate);
    const pretty = JSON.stringify(parsed, null, 2);
    return `${message.slice(0, start)}${pretty}${message.slice(end + 1)}`;
  } catch {
    return message;
  }
}

/**
 * Global, cross-charge-point Message Log (Task 9). Aggregates every CP's
 * `{type: "log"}` events via `useGlobalLogs` — there's no server-side
 * aggregate endpoint, so this is purely a client-side merge of per-CP
 * subscriptions (see that hook's doc comment). Two-pane layout: a filterable
 * row list on the left, full detail (with best-effort JSON pretty-printing)
 * for the selected row on the right.
 */
const LogsPage: React.FC = () => {
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { entries, paused, setPaused, clear } = useGlobalLogs();

  const [cpFilter, setCpFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const [textFilter, setTextFilter] = useState("");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return entries.filter(({ cpId, entry }) => {
      if (cpFilter !== "all" && cpId !== cpFilter) return false;
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (levelFilter !== "all" && entry.level < Number(levelFilter)) {
        return false;
      }
      if (query && !entry.message.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [entries, cpFilter, typeFilter, levelFilter, textFilter]);

  const selected: GlobalLogEntry | null = useMemo(() => {
    if (selectedSeq != null) {
      const found = filtered.find((e) => e.seq === selectedSeq);
      if (found) return found;
    }
    return filtered[0] ?? null;
  }, [filtered, selectedSeq]);

  return (
    <div className="p-6">
      <PageHeader
        title="Message Log"
        count={`${filtered.length} shown · ${entries.length} total`}
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={clear}>
              Clear
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={cpFilter}
          onChange={(e) => setCpFilter(e.target.value)}
          className={SELECT_CLASS}
          aria-label="Filter by charge point"
        >
          <option value="all">All charge points</option>
          {chargePoints.map((cp) => (
            <option key={cp.id} value={cp.id}>
              {cp.id}
            </option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className={SELECT_CLASS}
          aria-label="Filter by log type"
        >
          <option value="all">All types</option>
          {Object.values(LogType).map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className={SELECT_CLASS}
          aria-label="Minimum log level"
        >
          <option value="all">All levels</option>
          {LEVEL_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Filter messages…"
          className="min-w-[200px] flex-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Waiting for messages…"
          hint="OCPP traffic across every charge point will appear here as it happens."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="max-h-[600px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="px-2 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">CP</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {filtered.map((item) => (
                  <tr
                    key={item.seq}
                    data-seq={item.seq}
                    onClick={() => setSelectedSeq(item.seq)}
                    className={cn(
                      "cursor-pointer",
                      selected?.seq === item.seq
                        ? "bg-blue-50 dark:bg-blue-950"
                        : "hover:bg-gray-50 dark:hover:bg-gray-900",
                    )}
                  >
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {formatLogTime(item.entry.timestamp)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-200">
                      {item.cpId}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                          LOG_TYPE_CLASS[item.entry.type],
                        )}
                      >
                        {item.entry.type}
                      </span>
                    </td>
                    <td className="max-w-[280px] truncate px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300">
                      {item.entry.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            {selected ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {selected.cpId}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-semibold",
                      LOG_TYPE_CLASS[selected.entry.type],
                    )}
                  >
                    {selected.entry.type}
                  </span>
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      LOG_LEVEL_CLASS[selected.entry.level],
                    )}
                  >
                    {LogLevel[selected.entry.level]}
                  </span>
                </div>
                <div className="mb-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {selected.entry.timestamp.toISOString()}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-800 dark:text-gray-200">
                  {prettyPrintMessage(selected.entry.message)}
                </pre>
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select a message to see details.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LogsPage;
