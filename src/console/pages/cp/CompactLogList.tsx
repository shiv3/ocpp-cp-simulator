import React, { useEffect, useMemo, useRef } from "react";

import { annotateOcppLogs } from "@/components/ui/logEntryParsing";
import type { LogEntry } from "@/cp/shared/Logger";
import { cn } from "@/lib/utils";

import { formatLogTime } from "../../lib/useGlobalLogs";

/** The most rows drawn: the ring buffer holds thousands, and the Message Log
 *  page is where to read further back. */
export const MAX_ROWS = 500;

/** How far from the bottom (px) still counts as "following the log". */
const FOLLOW_SLACK_PX = 24;

/** What goes after the action: the OCPP payload without the transport's
 *  `Sent: ` / `Received: ` / `SOAP POST op:` framing, or the message itself. */
function payloadOf(message: string): string {
  for (const prefix of ["Sent: ", "Received: "]) {
    if (!message.startsWith(prefix)) continue;
    const rest = message.slice(prefix.length);
    try {
      const frame: unknown = JSON.parse(rest);
      if (Array.isArray(frame)) {
        // CALL [2,id,action,payload], CALLRESULT [3,id,payload],
        // CALLERROR [4,id,code,description,details].
        const body =
          frame[0] === 2
            ? frame[3]
            : frame[0] === 3
              ? frame[2]
              : frame.slice(2);
        return JSON.stringify(body);
      }
    } catch {
      // Not JSON: show it as logged.
    }
    return rest;
  }
  const soap = /^SOAP (?:POST|response) \S+: /.exec(message);
  return soap ? message.slice(soap[0].length) : message;
}

export interface CompactLogListProps {
  /** Oldest first. */
  logs: LogEntry[];
  /** Applied to the scrolling area: its height cap (`max-h-[340px]`). */
  className?: string;
}

/**
 * A charge point's messages as one line each: time, `↑` sent / `↓` received,
 * the OCPP action and the payload, truncated. The newest line is at the
 * bottom and the list follows it while the reader is at the bottom; scrolling
 * up pauses that until they scroll back down. Direction and action come from
 * `annotateOcppLogs` over the whole list, so a CALLRESULT still names the call
 * it answers.
 */
const CompactLogList: React.FC<CompactLogListProps> = ({ logs, className }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  const rows = useMemo(() => {
    const info = annotateOcppLogs(logs);
    return logs
      .map((entry, index) => ({ entry, info: info[index] }))
      .slice(-MAX_ROWS);
  }, [logs]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    followingRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };

  if (logs.length === 0) {
    return (
      <p className="rounded-[10px] border border-dashed border-cx-border-strong px-4 py-6 text-center text-sm text-cx-muted">
        No messages yet
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-cx-border bg-cx-card">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-testid="compact-log-scroller"
        className={cn("overflow-y-auto py-1", className)}
      >
        {rows.map(({ entry, info }, index) => (
          <div
            key={index}
            data-log-row
            title={entry.message}
            className="flex items-baseline gap-2 px-3 py-[3px] text-[12.5px] hover:bg-cx-sub"
          >
            <span className="shrink-0 font-mono text-cx-faint">
              {formatLogTime(entry.timestamp)}
            </span>
            {info.direction ? (
              <span
                data-direction={info.direction}
                aria-label={info.direction}
                className={cn(
                  "w-3 shrink-0 text-center font-mono",
                  info.direction === "sent"
                    ? "text-cx-accent"
                    : "text-cx-emerald",
                )}
              >
                {info.direction === "sent" ? "↑" : "↓"}
              </span>
            ) : (
              <span aria-hidden className="w-3 shrink-0" />
            )}
            {info.direction && (
              <span className="shrink-0 font-medium text-cx-fg">
                {info.action ?? "response"}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-cx-muted">
              {payloadOf(entry.message)}
            </span>
          </div>
        ))}
      </div>
      {logs.length > MAX_ROWS && (
        <p className="border-t border-cx-border px-3 py-1 text-xs text-cx-faint">
          Showing the latest {MAX_ROWS} of {logs.length}; the Message Log page
          has the rest.
        </p>
      )}
    </div>
  );
};

export default CompactLogList;
