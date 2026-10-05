import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";

import { LogEntry, LogLevel, LogType } from "@/cp/shared/Logger";
import {
  annotateOcppLogs,
  type LogDirection,
} from "@/components/ui/logEntryParsing";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Where "Clear" should reach: just the in-memory log buffer the screen
 *  is reading (`"screen"`), or also the persisted DB rows (`"all"`). */
export type ClearLogsScope = "screen" | "all";

/** A log line, optionally tagged with the charge point it came from. With
 *  tagged lines the viewer grows a Charge point filter group and column. */
export type ViewerLogEntry = LogEntry & { cpId?: string };

export interface LogViewerProps {
  /** Oldest first. Keep the entry objects stable across renders (the ring
   *  buffer's own objects do): an expanded row is remembered by identity. */
  logs: ViewerLogEntry[];
  onClear?: (scope: ClearLogsScope) => void;
  /** Hook for the "Download" button. Omitting it hides the button. */
  onDownload?: () => void;
  /** The checked Charge point ids; owning them lets a page keep them in the
   *  URL. Without it the viewer keeps the selection itself. */
  selectedCpIds?: string[];
  onCpFilterChange?: (ids: string[]) => void;
  /** Caps the table's height; without it the table fills the viewer, which
   *  the caller sizes (`className="h-full"` in a flex column). */
  maxHeight?: string;
  /** Whether the filter sidebar starts open (default `true`). The toolbar's
   *  Filters button shows or hides it afterwards; the viewer owns the state.
   *  A narrow host such as the charge point's side panel starts it closed. */
  defaultFiltersOpen?: boolean;
  className?: string;
}

/**
 * "(none)" pseudo-value used in the Connector filter for log entries that
 * don't reference any connector. `null` represents the real "no connector"
 * case so we can keep the filter list as `(number | null)[]`.
 */
type ConnectorFilterValue = number | null;

/**
 * "(none)" pseudo-value for the Direction/Action filters, used for log
 * entries {@link annotateOcppLogs} couldn't parse an OCPP direction/action
 * out of (#178 2.4) — same `null`-means-"(none)" convention as
 * {@link ConnectorFilterValue}.
 */
type DirectionFilterValue = LogDirection | null;
type ActionFilterValue = string | null;

// Full literal class strings: Tailwind only sees class names that appear
// verbatim in source. The `cx-*` tokens switch with the theme, so there is no
// `dark:` twin. The old filled `.log-*` badges are not used here: a dot carries
// the color, the text beside it carries the meaning.
const LEVEL_DOT: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "bg-cx-gray",
  [LogLevel.INFO]: "bg-cx-blue",
  [LogLevel.WARN]: "bg-cx-amber",
  [LogLevel.ERROR]: "bg-cx-rose",
};

const TYPE_DOT: Record<LogType, string> = {
  [LogType.WEBSOCKET]: "bg-cx-purple",
  [LogType.OCPP]: "bg-cx-blue",
  [LogType.TRANSACTION]: "bg-cx-emerald",
  [LogType.HEARTBEAT]: "bg-cx-rose",
  [LogType.METER_VALUE]: "bg-cx-amber",
  [LogType.STATUS]: "bg-cx-accent",
  [LogType.CONFIGURATION]: "bg-cx-amber",
  [LogType.DIAGNOSTICS]: "bg-cx-rose",
  [LogType.SCENARIO]: "bg-cx-gray",
  [LogType.GENERAL]: "bg-cx-gray",
  [LogType.SYSTEM]: "bg-cx-gray",
  [LogType.NETWORK_SIM]: "bg-cx-purple",
};

const DIRECTION_DOT: Record<LogDirection, string> = {
  sent: "bg-cx-accent",
  received: "bg-cx-emerald",
};

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

/**
 * Pretty-prints the first `{...}` JSON substring found in `message`, leaving
 * the surrounding prose untouched. Best-effort: any parse failure (unbalanced
 * braces, non-JSON content that merely looks bracketed, …) falls back to the
 * original message unchanged.
 */
function prettyPrintMessage(message: string): string {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return message;
  try {
    const parsed: unknown = JSON.parse(message.slice(start, end + 1));
    return `${message.slice(0, start)}${JSON.stringify(parsed, null, 2)}${message.slice(end + 1)}`;
  } catch {
    return message;
  }
}

/** Toggles `value` in `list` (add when absent, remove when present). */
function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/** Increments `key`'s count in `counts`. */
function bump<K>(counts: Map<K, number>, key: K) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

interface FilterOption {
  key: string;
  label: string;
  count: number;
  checked: boolean;
  /** `bg-cx-*` class of a small dot before the label. */
  dot?: string;
  onToggle: () => void;
}

/** One sidebar group: an uppercase heading that folds it, a search box over
 *  the values and a checkbox per value with its count. */
const FilterGroup: React.FC<{
  title: string;
  options: FilterOption[];
  emptyText?: string;
  /** Tailwind `max-h-*` of the option list. */
  listClassName?: string;
}> = ({ title, options, emptyText, listClassName = "max-h-48" }) => {
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState("");
  const query = search.toLowerCase();
  const shown = query
    ? options.filter((o) => o.label.toLowerCase().includes(query))
    : options;

  return (
    <section data-filter-group={title} className="border-b border-cx-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-cx-muted hover:bg-cx-sub"
      >
        {title}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          <Input
            placeholder="Filter values"
            aria-label={`Filter ${title} values`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
          />
          <div className={cn("space-y-0.5 overflow-y-auto", listClassName)}>
            {shown.length === 0 && emptyText ? (
              <p className="px-1 text-xs italic text-cx-faint">{emptyText}</p>
            ) : (
              shown.map((option) => (
                <label
                  key={option.key}
                  data-filter-option={option.label}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-cx-sub"
                >
                  <input
                    type="checkbox"
                    checked={option.checked}
                    onChange={option.onToggle}
                  />
                  {option.dot && (
                    <span
                      aria-hidden
                      className={cn(
                        "h-[7px] w-[7px] shrink-0 rounded-full",
                        option.dot,
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-cx-fg2">
                    {option.label}
                  </span>
                  <span className="font-mono text-[11px] text-cx-faint">
                    {option.count}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
};

const TH_CLASS =
  "h-9 px-2 text-left align-middle text-[11px] font-semibold uppercase tracking-[0.06em] text-cx-muted";

export function LogViewer({
  logs,
  onClear,
  onDownload,
  selectedCpIds,
  onCpFilterChange,
  maxHeight,
  defaultFiltersOpen = true,
  className,
}: LogViewerProps) {
  const filtersId = useId();
  const [filtersOpen, setFiltersOpen] = useState(defaultFiltersOpen);
  const [filter, setFilter] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel[]>([]);
  const [logTypeFilter, setLogTypeFilter] = useState<LogType[]>([]);
  const [logConnectorFilter, setLogConnectorFilter] = useState<
    ConnectorFilterValue[]
  >([]);
  const [logDirectionFilter, setLogDirectionFilter] = useState<
    DirectionFilterValue[]
  >([]);
  const [logActionFilter, setLogActionFilter] = useState<ActionFilterValue[]>(
    [],
  );
  const [ownCpFilter, setOwnCpFilter] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  // Charge point selection: the owner's when it passes one, else ours.
  const cpFilter = selectedCpIds ?? ownCpFilter;
  const setCpFilter = (next: string[]) => {
    if (selectedCpIds === undefined) setOwnCpFilter(next);
    onCpFilterChange?.(next);
  };

  // A stable id per entry object: the React key and the "expanded" marker,
  // neither of which may follow the row's index while the ring buffer drops
  // its oldest lines.
  const rowIds = useRef(new WeakMap<LogEntry, number>());
  const nextRowId = useRef(0);
  const rowId = (log: LogEntry): number => {
    let id = rowIds.current.get(log);
    if (id === undefined) {
      id = nextRowId.current++;
      rowIds.current.set(log, id);
    }
    return id;
  };

  const hasCp = useMemo(
    () => logs.some((log) => log.cpId !== undefined) || cpFilter.length > 0,
    [logs, cpFilter],
  );

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
    const levelCounts = new Map<LogLevel, number>();
    const typeCounts = new Map<LogType, number>();
    const cpCounts = new Map<string, number>();
    const connectorCounts = new Map<ConnectorFilterValue, number>();
    const directionCounts = new Map<DirectionFilterValue, number>();
    const actionCounts = new Map<ActionFilterValue, number>();

    logs.forEach((log, idx) => {
      bump(levelCounts, log.level);
      bump(typeCounts, log.type);
      if (log.cpId !== undefined) bump(cpCounts, log.cpId);

      const ids = logConnectors[idx];
      if (ids.length === 0) bump(connectorCounts, null);
      else for (const id of ids) bump(connectorCounts, id);

      const info = logOcppInfo[idx];
      bump(directionCounts, info.direction ?? null);
      bump(actionCounts, info.action ?? null);
    });

    return {
      levelCounts,
      typeCounts,
      cpCounts,
      connectorCounts,
      directionCounts,
      actionCounts,
    };
  }, [logs, logConnectors, logOcppInfo]);

  // Pairs each surviving entry with its index in the original `logs` array
  // (not its position after filtering) so the row renderer can still look
  // up per-entry data — like `logOcppInfo` — keyed against the full list.
  const filteredLogs = useMemo(() => {
    const query = filter.toLowerCase();
    return logs
      .map((log, idx) => ({ log, idx }))
      .filter(({ log, idx }) => {
        if (query && !log.message.toLowerCase().includes(query)) return false;
        if (cpFilter.length > 0 && !cpFilter.includes(log.cpId ?? "")) {
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
        if (logDirectionFilter.length > 0) {
          const direction = logOcppInfo[idx].direction ?? null;
          if (!logDirectionFilter.includes(direction)) return false;
        }
        if (logActionFilter.length > 0) {
          const action = logOcppInfo[idx].action ?? null;
          if (!logActionFilter.includes(action)) return false;
        }
        return true;
      });
  }, [
    logs,
    filter,
    cpFilter,
    logLevelFilter,
    logTypeFilter,
    logConnectorFilter,
    logConnectors,
    logDirectionFilter,
    logActionFilter,
    logOcppInfo,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [filteredLogs, autoScroll]);

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Sidebar option lists. Null ("(none)") sorts last in every group.
  const cpOptions: FilterOption[] = [
    ...new Set([...stats.cpCounts.keys(), ...cpFilter]),
  ]
    .sort()
    .map((id) => ({
      key: id,
      label: id,
      count: stats.cpCounts.get(id) ?? 0,
      checked: cpFilter.includes(id),
      onToggle: () => setCpFilter(toggled(cpFilter, id)),
    }));

  const levelOptions: FilterOption[] = [
    LogLevel.DEBUG,
    LogLevel.INFO,
    LogLevel.WARN,
    LogLevel.ERROR,
  ].map((level) => ({
    key: String(level),
    label: LogLevel[level],
    count: stats.levelCounts.get(level) ?? 0,
    checked: logLevelFilter.includes(level),
    dot: LEVEL_DOT[level],
    onToggle: () => setLogLevelFilter(toggled(logLevelFilter, level)),
  }));

  // Most frequent first.
  const typeOptions: FilterOption[] = Object.values(LogType)
    .sort(
      (a, b) => (stats.typeCounts.get(b) ?? 0) - (stats.typeCounts.get(a) ?? 0),
    )
    .map((type) => ({
      key: type,
      label: type,
      count: stats.typeCounts.get(type) ?? 0,
      checked: logTypeFilter.includes(type),
      dot: TYPE_DOT[type],
      onToggle: () => setLogTypeFilter(toggled(logTypeFilter, type)),
    }));

  const connectorOptions: FilterOption[] = [...stats.connectorCounts.keys()]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
    .map((value) => ({
      key: value === null ? "none" : `c${value}`,
      label:
        value === null
          ? "(none)"
          : value === 0
            ? "0 (charge point)"
            : `Connector ${value}`,
      count: stats.connectorCounts.get(value) ?? 0,
      checked: logConnectorFilter.includes(value),
      onToggle: () => setLogConnectorFilter(toggled(logConnectorFilter, value)),
    }));

  const directionOptions: FilterOption[] = [...stats.directionCounts.keys()]
    .sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map((value) => ({
      key: value ?? "none",
      label: value === null ? "(none)" : value === "sent" ? "Sent" : "Received",
      count: stats.directionCounts.get(value) ?? 0,
      checked: logDirectionFilter.includes(value),
      dot: value === null ? undefined : DIRECTION_DOT[value],
      onToggle: () => setLogDirectionFilter(toggled(logDirectionFilter, value)),
    }));

  // Most frequent first (mirrors the Type group), (none) last (#178 2.4).
  const actionOptions: FilterOption[] = [...stats.actionCounts.keys()]
    .sort((a, b) =>
      a === null
        ? 1
        : b === null
          ? -1
          : (stats.actionCounts.get(b) ?? 0) - (stats.actionCounts.get(a) ?? 0),
    )
    .map((value) => ({
      key: value ?? "none",
      label: value ?? "(none)",
      count: stats.actionCounts.get(value) ?? 0,
      checked: logActionFilter.includes(value),
      onToggle: () => setLogActionFilter(toggled(logActionFilter, value)),
    }));

  const columnCount = hasCp ? 8 : 7;

  // Filter groups with a selection: a closed sidebar hides them, so the
  // Filters button counts them.
  const activeFilterGroups = [
    cpFilter,
    logLevelFilter,
    logTypeFilter,
    logConnectorFilter,
    logDirectionFilter,
    logActionFilter,
  ].filter((selection) => selection.length > 0).length;

  return (
    <div
      className={cn(
        "flex min-h-0 overflow-hidden rounded-[10px] border border-cx-border bg-cx-card",
        className,
      )}
    >
      {/* Left sidebar: filters */}
      <div
        id={filtersId}
        hidden={!filtersOpen}
        className="flex w-64 shrink-0 flex-col border-r border-cx-border bg-cx-side"
      >
        <div className="border-b border-cx-border px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-cx-muted">
          Filters
        </div>
        <div className="flex-1 overflow-y-auto">
          {hasCp && (
            <FilterGroup
              title="Charge point"
              options={cpOptions}
              emptyText="No charge points yet"
            />
          )}
          <FilterGroup title="Level" options={levelOptions} />
          <FilterGroup
            title="Type"
            options={typeOptions}
            listClassName="max-h-64"
          />
          <FilterGroup
            title="Connector"
            options={connectorOptions}
            emptyText="No connector references yet"
          />
          <FilterGroup title="Direction" options={directionOptions} />
          <FilterGroup
            title="Action"
            options={actionOptions}
            emptyText="No OCPP actions parsed yet"
            listClassName="max-h-64"
          />
        </div>
      </div>

      {/* Right side: toolbar, search, table. min-w-0 overrides the flex-item
       *  default `min-width: auto`, which would otherwise let a wide log
       *  table force this column (and the whole page) wider instead of
       *  scrolling inside its own container (#178 2.1). */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar. Wraps instead of clipping when the viewer is narrow (#405). */}
        <div
          data-testid="log-toolbar"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-cx-border bg-cx-sub px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={filtersOpen}
              aria-controls={filtersId}
              aria-label="Filters"
              title="Show or hide the filters"
              onClick={() => setFiltersOpen((open) => !open)}
              className={cn(filtersOpen && "bg-cx-sub text-cx-fg")}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {!filtersOpen && activeFilterGroups > 0 && (
                <span className="rounded-full bg-cx-accent px-1.5 text-[10.5px] leading-4 text-white">
                  {activeFilterGroups}
                </span>
              )}
            </Button>
            <h3 className="text-[13px] font-semibold text-cx-fg">Logs</h3>
            <span className="font-mono text-[11.5px] text-cx-muted">
              {logs.length} total / {filteredLogs.length} filtered
            </span>
          </div>
          <div
            data-toolbar-actions
            className="flex flex-wrap items-center gap-2"
          >
            <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-cx-fg2">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>
            {onDownload && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onDownload}
                title="Download every persisted log row as a JSON Lines file."
              >
                Download
              </Button>
            )}
            {onClear && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onClear("screen")}
                  title="Hide the currently-displayed log lines. Persisted history stays."
                >
                  Clear screen
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => onClear("all")}
                  title="Hide the displayed lines AND delete the persisted log rows."
                >
                  Clear screen + DB
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="border-b border-cx-border p-3">
          <Input
            placeholder="Search in messages..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full"
          />
        </div>

        {/* Table */}
        <div
          className="relative min-h-0 flex-1 overflow-x-auto overflow-y-auto"
          ref={containerRef}
          style={maxHeight ? { maxHeight } : undefined}
        >
          <table className="w-full caption-bottom text-sm">
            <thead className="sticky top-0 z-10 border-b border-cx-border bg-cx-card">
              <tr>
                <th className="h-9 w-8 px-2">
                  <span className="sr-only">Details</span>
                </th>
                <th className={cn(TH_CLASS, "w-[110px]")}>Timestamp</th>
                {hasCp && (
                  <th className={cn(TH_CLASS, "w-[120px]")}>Charge point</th>
                )}
                <th className={cn(TH_CLASS, "w-[90px]")}>Level</th>
                <th className={cn(TH_CLASS, "w-[140px]")}>Type</th>
                <th className={cn(TH_CLASS, "w-[110px]")}>Direction</th>
                <th className={cn(TH_CLASS, "w-[180px]")}>Action</th>
                <th className={TH_CLASS}>Message</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td
                    colSpan={columnCount}
                    className="px-2 py-8 text-center text-cx-muted"
                  >
                    {logs.length === 0
                      ? "No logs yet"
                      : "No logs match the current filters"}
                  </td>
                </tr>
              ) : (
                filteredLogs.map(({ log, idx }) => {
                  const ocppInfo = logOcppInfo[idx];
                  const id = rowId(log);
                  const open = expanded.has(id);
                  return (
                    <React.Fragment key={id}>
                      <tr className="border-b border-cx-border font-mono text-xs text-cx-fg2 hover:bg-cx-sub">
                        <td className="px-2 align-middle">
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={open ? "Hide details" : "Show details"}
                            onClick={() => toggleExpanded(id)}
                            className="rounded p-0.5 text-cx-faint hover:bg-cx-sub hover:text-cx-fg2"
                          >
                            <ChevronRight
                              className={cn(
                                "h-4 w-4 transition-transform",
                                open && "rotate-90",
                              )}
                            />
                          </button>
                        </td>
                        <td className="whitespace-nowrap p-2 align-middle font-mono text-cx-muted">
                          {log.timestamp.toISOString().substring(11, 23)}
                        </td>
                        {hasCp && (
                          <td className="whitespace-nowrap p-2 align-middle font-mono text-cx-fg">
                            {log.cpId ?? (
                              <span className="text-cx-faint">—</span>
                            )}
                          </td>
                        )}
                        <td className="p-2 align-middle">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              data-level-dot
                              className={cn(
                                "h-[7px] w-[7px] rounded-full",
                                LEVEL_DOT[log.level],
                              )}
                            />
                            {LogLevel[log.level]}
                          </span>
                        </td>
                        <td className="p-2 align-middle">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              data-type-dot
                              className={cn(
                                "h-[7px] w-[7px] rounded-full",
                                TYPE_DOT[log.type],
                              )}
                            />
                            {log.type}
                          </span>
                        </td>
                        <td className="whitespace-nowrap p-2 align-middle">
                          {ocppInfo.direction ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                data-direction-dot
                                className={cn(
                                  "h-[7px] w-[7px] rounded-full",
                                  DIRECTION_DOT[ocppInfo.direction],
                                )}
                              />
                              {ocppInfo.direction === "sent"
                                ? "→ Sent"
                                : "← Received"}
                            </span>
                          ) : (
                            <span className="text-cx-faint">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap p-2 align-middle font-mono text-cx-fg">
                          {ocppInfo.action ?? (
                            <span className="text-cx-faint">—</span>
                          )}
                        </td>
                        {/* whitespace-nowrap (was break-all): a long payload
                         *  stays on one line and scrolls horizontally in the
                         *  container above instead of wrapping
                         *  character-by-character into a mangled block
                         *  (#178 2.1). The chevron shows the whole message. */}
                        <td className="whitespace-nowrap p-2 align-middle">
                          {log.message}
                        </td>
                      </tr>
                      {open && (
                        <tr
                          data-log-detail
                          className="border-b border-cx-border bg-cx-sub"
                        >
                          <td colSpan={columnCount} className="px-4 py-3">
                            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-cx-fg">
                              {prettyPrintMessage(log.message)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
