import React, { useEffect, useMemo, useState } from "react";
import { LogEntry, LogLevel, LogType } from "@/cp/shared/Logger";
import { annotateOcppLogs } from "@/components/ui/logEntryParsing";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

/** Where "Clear" should reach: just the in-memory log buffer the screen
 *  is reading (`"screen"`), or also the persisted DB rows (`"all"`). */
export type ClearLogsScope = "screen" | "all";

interface LogViewerProps {
  logs: LogEntry[];
  onClear?: (scope: ClearLogsScope) => void;
  /** Hook for the "Download logs" button. The component invokes this when
   *  the user clicks Download; ChargePoint.tsx pulls the persisted log
   *  rows from the DB and writes a JSON Lines file. Omitting this prop
   *  hides the button (used by demo / nested viewers without a CP id). */
  onDownload?: () => void;
  maxHeight?: string;
  className?: string;
}

/**
 * "(none)" pseudo-value used in the Connector filter for log entries that
 * don't reference any connector. `null` represents the real "no connector"
 * case so we can keep the filter list as `(number | null)[]`.
 */
type ConnectorFilterValue = number | null;

/**
 * Best-effort: pull every connector id referenced by a log message.
 *
 * Matches:
 *   - JSON payload field:           `"connectorId":3`
 *   - Prose mentions:               `connector 4`, `Connector 0`
 *   - Scenario template instances:  `Demo Charging (Connector 2)`
 *
 * Returns an empty array when no connector reference is detected (the log
 * is treated as charge-point-level / "(none)").
 */
function extractConnectorIds(message: string): number[] {
  const found = new Set<number>();
  const jsonRe = /"connectorId"\s*:\s*(\d+)/g;
  const proseRe = /\bconnector(?:s)?\s+(\d+)/gi;
  for (const m of message.matchAll(jsonRe)) {
    found.add(Number(m[1]));
  }
  for (const m of message.matchAll(proseRe)) {
    found.add(Number(m[1]));
  }
  return [...found];
}

export function LogViewer({
  logs,
  onClear,
  onDownload,
  maxHeight = "500px",
  className,
}: LogViewerProps) {
  const [filter, setFilter] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel[]>([]);
  const [logTypeFilter, setLogTypeFilter] = useState<LogType[]>([]);
  const [logConnectorFilter, setLogConnectorFilter] = useState<
    ConnectorFilterValue[]
  >([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [levelSearch, setLevelSearch] = useState("");
  const [typeSearch, setTypeSearch] = useState("");
  const [connectorSearch, setConnectorSearch] = useState("");
  const [levelExpanded, setLevelExpanded] = useState(true);
  const [typeExpanded, setTypeExpanded] = useState(true);
  const [connectorExpanded, setConnectorExpanded] = useState(true);

  // Each log's set of referenced connector ids — memoized so we don't
  // re-parse the message on every render or every filter toggle.
  const logConnectors = useMemo(
    () => logs.map((log) => extractConnectorIds(log.message)),
    [logs],
  );

  // Best-effort OCPP action + wire direction per entry (#178 2.2/2.3).
  // Parsed from `logs` (the full, chronological list) rather than
  // `filteredLogs` — see logEntryParsing.ts: CALLRESULT/CALLERROR frames
  // need to correlate back to an earlier CALL frame by message id, which
  // breaks if an active filter hides that earlier entry.
  const logOcppInfo = useMemo(() => annotateOcppLogs(logs), [logs]);

  // Calculate statistics
  const stats = useMemo(() => {
    const levelCounts: Record<LogLevel, number> = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0,
    };
    const typeCounts: Record<LogType, number> = {} as Record<LogType, number>;
    const connectorCounts = new Map<ConnectorFilterValue, number>();

    logs.forEach((log, idx) => {
      levelCounts[log.level] = (levelCounts[log.level] || 0) + 1;
      typeCounts[log.type] = (typeCounts[log.type] || 0) + 1;

      const ids = logConnectors[idx];
      if (ids.length === 0) {
        connectorCounts.set(null, (connectorCounts.get(null) ?? 0) + 1);
      } else {
        for (const id of ids) {
          connectorCounts.set(id, (connectorCounts.get(id) ?? 0) + 1);
        }
      }
    });

    return { levelCounts, typeCounts, connectorCounts };
  }, [logs, logConnectors]);

  // Pairs each surviving entry with its index in the original `logs` array
  // (not its position after filtering) so the row renderer can still look
  // up per-entry data — like `logOcppInfo` — keyed against the full list.
  const filteredLogs = useMemo(() => {
    return logs
      .map((log, idx) => ({ log, idx }))
      .filter(({ log, idx }) => {
        if (
          filter &&
          !log.message.toLowerCase().includes(filter.toLowerCase())
        ) {
          return false;
        }
        if (logLevelFilter.length > 0 && !logLevelFilter.includes(log.level)) {
          return false;
        }
        if (logTypeFilter.length > 0 && !logTypeFilter.includes(log.type)) {
          return false;
        }
        if (logConnectorFilter.length > 0) {
          const ids = logConnectors[idx];
          const match =
            ids.length === 0
              ? logConnectorFilter.includes(null)
              : ids.some((id) => logConnectorFilter.includes(id));
          if (!match) return false;
        }
        return true;
      });
  }, [
    logs,
    filter,
    logLevelFilter,
    logTypeFilter,
    logConnectorFilter,
    logConnectors,
  ]);

  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [filteredLogs, autoScroll]);

  const getLogLevelBadgeVariant = (
    level: LogLevel,
  ): "default" | "secondary" | "destructive" | "outline" => {
    switch (level) {
      case LogLevel.ERROR:
        return "destructive";
      case LogLevel.WARN:
        return "default";
      case LogLevel.INFO:
        return "secondary";
      case LogLevel.DEBUG:
        return "outline";
      default:
        return "secondary";
    }
  };

  const getLogTypeBadgeColor = (type: LogType): string => {
    switch (type) {
      case LogType.WEBSOCKET:
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
      case LogType.OCPP:
        return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300";
      case LogType.TRANSACTION:
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
      case LogType.HEARTBEAT:
        return "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300";
      case LogType.METER_VALUE:
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300";
      case LogType.STATUS:
        return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300";
      case LogType.CONFIGURATION:
        return "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300";
      case LogType.DIAGNOSTICS:
        return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300";
      case LogType.SCENARIO:
        return "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300";
    }
  };

  const toggleLogLevel = (level: LogLevel) => {
    if (logLevelFilter.includes(level)) {
      setLogLevelFilter(logLevelFilter.filter((l) => l !== level));
    } else {
      setLogLevelFilter([...logLevelFilter, level]);
    }
  };

  const toggleLogType = (type: LogType) => {
    if (logTypeFilter.includes(type)) {
      setLogTypeFilter(logTypeFilter.filter((t) => t !== type));
    } else {
      setLogTypeFilter([...logTypeFilter, type]);
    }
  };

  const toggleLogConnector = (value: ConnectorFilterValue) => {
    if (logConnectorFilter.includes(value)) {
      setLogConnectorFilter(logConnectorFilter.filter((v) => v !== value));
    } else {
      setLogConnectorFilter([...logConnectorFilter, value]);
    }
  };

  const connectorLabel = (value: ConnectorFilterValue): string =>
    value === null
      ? "(none)"
      : value === 0
        ? "0 (charge point)"
        : `Connector ${value}`;

  // Surface every connector id that's appeared in logs so far, sorted with
  // (none) last. Filter by the search box (matches the rendered label).
  const filteredConnectors = useMemo(() => {
    const all: ConnectorFilterValue[] = [...stats.connectorCounts.keys()].sort(
      (a, b) => {
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b;
      },
    );
    if (!connectorSearch) return all;
    const q = connectorSearch.toLowerCase();
    return all.filter((v) => connectorLabel(v).toLowerCase().includes(q));
  }, [stats.connectorCounts, connectorSearch]);

  // Filtered level and type lists for search
  const filteredLevels = useMemo(() => {
    return Object.values(LogLevel)
      .filter((value) => typeof value === "number")
      .filter((level) =>
        LogLevel[level as LogLevel]
          .toLowerCase()
          .includes(levelSearch.toLowerCase()),
      ) as LogLevel[];
  }, [levelSearch]);

  const filteredTypes = useMemo(() => {
    return Object.values(LogType)
      .filter((type) => type.toLowerCase().includes(typeSearch.toLowerCase()))
      .sort((a, b) => (stats.typeCounts[b] || 0) - (stats.typeCounts[a] || 0));
  }, [typeSearch, stats.typeCounts]);

  return (
    <div
      className={cn("flex h-full border rounded-lg overflow-hidden", className)}
    >
      {/* Left Sidebar - Filters */}
      <div className="w-64 border-r bg-muted/20 flex flex-col">
        {/* Header */}
        <div className="p-3 border-b bg-muted/50">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Filters
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Log Level Filter */}
          <div className="border-b">
            <button
              onClick={() => setLevelExpanded(!levelExpanded)}
              className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            >
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Level
              </span>
              {levelExpanded ? (
                <ChevronDown className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              )}
            </button>
            {levelExpanded && (
              <div className="px-3 pb-3 space-y-2">
                <Input
                  placeholder="Filter values"
                  value={levelSearch}
                  onChange={(e) => setLevelSearch(e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {filteredLevels.map((level) => (
                    <label
                      key={level}
                      className="flex items-center justify-between p-1.5 hover:bg-muted/50 rounded cursor-pointer group"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Checkbox
                          checked={logLevelFilter.includes(level)}
                          onCheckedChange={() => toggleLogLevel(level)}
                        />
                        <span className="text-xs text-gray-900 dark:text-gray-100 truncate">
                          {LogLevel[level]}
                        </span>
                      </div>
                      <Badge
                        variant="outline"
                        className="ml-2 text-xs px-1.5 py-0"
                      >
                        {stats.levelCounts[level] || 0}
                      </Badge>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Log Type Filter */}
          <div className="border-b">
            <button
              onClick={() => setTypeExpanded(!typeExpanded)}
              className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            >
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Type
              </span>
              {typeExpanded ? (
                <ChevronDown className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              )}
            </button>
            {typeExpanded && (
              <div className="px-3 pb-3 space-y-2">
                <Input
                  placeholder="Filter values"
                  value={typeSearch}
                  onChange={(e) => setTypeSearch(e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {filteredTypes.map((type) => (
                    <label
                      key={type}
                      className="flex items-center justify-between p-1.5 hover:bg-muted/50 rounded cursor-pointer group"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Checkbox
                          checked={logTypeFilter.includes(type)}
                          onCheckedChange={() => toggleLogType(type)}
                        />
                        <span className="text-xs text-gray-900 dark:text-gray-100 truncate">
                          {type}
                        </span>
                      </div>
                      <Badge
                        variant="outline"
                        className="ml-2 text-xs px-1.5 py-0"
                      >
                        {stats.typeCounts[type] || 0}
                      </Badge>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Connector Filter */}
          <div className="border-b">
            <button
              onClick={() => setConnectorExpanded(!connectorExpanded)}
              className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            >
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Connector
              </span>
              {connectorExpanded ? (
                <ChevronDown className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              )}
            </button>
            {connectorExpanded && (
              <div className="px-3 pb-3 space-y-2">
                <Input
                  placeholder="Filter values"
                  value={connectorSearch}
                  onChange={(e) => setConnectorSearch(e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {filteredConnectors.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic px-1">
                      No connector references yet
                    </p>
                  ) : (
                    filteredConnectors.map((value) => {
                      const key = value === null ? "none" : `c${value}`;
                      return (
                        <label
                          key={key}
                          className="flex items-center justify-between p-1.5 hover:bg-muted/50 rounded cursor-pointer group"
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Checkbox
                              checked={logConnectorFilter.includes(value)}
                              onCheckedChange={() => toggleLogConnector(value)}
                            />
                            <span className="text-xs text-gray-900 dark:text-gray-100 truncate">
                              {connectorLabel(value)}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className="ml-2 text-xs px-1.5 py-0"
                          >
                            {stats.connectorCounts.get(value) || 0}
                          </Badge>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Side - Logs */}
      {/* min-w-0 overrides the flex-item default `min-width: auto`, which
       *  would otherwise let a wide log table force this column (and the
       *  whole page) wider instead of scrolling inside its own container
       *  (#178 2.1). */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <div className="flex justify-between items-center p-3 border-b bg-muted/50">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Logs
            </h3>
            <Badge variant="outline">
              {logs.length} total / {filteredLogs.length} filtered
            </Badge>
          </div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(checked) => setAutoScroll(checked as boolean)}
              />
              Auto-scroll
            </label>
            <div className="flex items-center gap-1">
              {onDownload && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onDownload}
                  title="Download every persisted log row for this CP as a JSON Lines file."
                >
                  Download
                </Button>
              )}
              {onClear && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onClear("screen")}
                    title="Hide the currently-displayed log lines. Persisted history stays."
                  >
                    Clear screen
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onClear("all")}
                    title="Hide the displayed lines AND delete persisted log rows for this CP."
                  >
                    Clear screen + DB
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Search Bar */}
        <div className="p-3 border-b">
          <Input
            placeholder="Search in messages..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full"
          />
        </div>

        {/* Log Table */}
        <div
          className="flex-1 overflow-x-auto overflow-y-auto relative"
          ref={containerRef}
          style={{ maxHeight }}
        >
          <table className="w-full caption-bottom text-sm">
            <thead className="sticky top-0 bg-background z-10 border-b shadow-sm">
              <tr className="border-b">
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[140px]">
                  Timestamp
                </th>
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[90px]">
                  Level
                </th>
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[140px]">
                  Type
                </th>
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[100px]">
                  Direction
                </th>
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[180px]">
                  Action
                </th>
                <th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground">
                  Message
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr className="border-b">
                  <td
                    colSpan={6}
                    className="p-2 text-center text-muted-foreground py-8"
                  >
                    {logs.length === 0
                      ? "No logs yet"
                      : "No logs match the current filters"}
                  </td>
                </tr>
              ) : (
                filteredLogs.map(({ log, idx }) => {
                  const ocppInfo = logOcppInfo[idx];
                  return (
                    <tr
                      key={idx}
                      className="border-b transition-colors hover:bg-muted/50 font-mono text-xs"
                    >
                      <td className="p-2 align-middle text-muted-foreground">
                        {log.timestamp.toISOString().substring(11, 23)}
                      </td>
                      <td className="p-2 align-middle">
                        <Badge variant={getLogLevelBadgeVariant(log.level)}>
                          {LogLevel[log.level]}
                        </Badge>
                      </td>
                      <td className="p-2 align-middle">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "font-normal",
                            getLogTypeBadgeColor(log.type),
                          )}
                        >
                          {log.type}
                        </Badge>
                      </td>
                      <td className="p-2 align-middle">
                        {ocppInfo.direction ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              "font-normal whitespace-nowrap",
                              ocppInfo.direction === "sent"
                                ? "border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-300"
                                : "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300",
                            )}
                          >
                            {ocppInfo.direction === "sent"
                              ? "→ Sent"
                              : "← Received"}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2 align-middle whitespace-nowrap">
                        {ocppInfo.action ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      {/* whitespace-nowrap (was break-all): a long payload
                       *  now stays on one line and scrolls horizontally in
                       *  the container above instead of wrapping
                       *  character-by-character into a mangled block
                       *  (#178 2.1). */}
                      <td className="p-2 align-middle whitespace-nowrap">
                        {log.message}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
