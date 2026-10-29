import React from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";

import type {
  TimelineEntry,
  TimelineKind,
} from "@/cp/application/services/OperationalTimeline";
import { cn } from "@/lib/utils";

import EmptyState from "../../components/EmptyState";
import { buildRunUrl } from "../../lib/useAllScenarios";
import { formatLogTime } from "../../lib/useGlobalLogs";
import { useOperationalTimeline } from "../../lib/useOperationalTimeline";

export interface OperationalTimelinePanelProps {
  cpId: string;
}

type Tone = "fault" | "recovery" | "connection" | "neutral";

const TONE_BY_KIND: Partial<Record<TimelineKind, Tone>> = {
  network_fault_injected: "fault",
  disconnected: "fault",
  authorization_rejected: "fault",
  transaction_rejected: "fault",
  transaction_message_rejected: "fault",
  transaction_message_discarded: "fault",
  scenario_error: "fault",
  recovery_completed: "recovery",
  connected: "connection",
  reconnecting: "connection",
  boot_notification: "connection",
};

const TONE_CLASS: Record<Tone, string> = {
  fault: "border-cx-rose/40 bg-cx-rose/10 text-cx-rose",
  recovery: "border-cx-emerald/40 bg-cx-emerald/10 text-cx-emerald",
  connection: "border-cx-accent/40 bg-cx-accent/10 text-cx-accent",
  neutral: "border-cx-border bg-cx-sub text-cx-fg2",
};

/** An entry never changes for a given `seq`, so a re-read (or a loading
 *  flag flip) re-renders only the rows it adds. */
const TimelineRow = React.memo(function TimelineRow({
  entry,
}: {
  entry: TimelineEntry;
}) {
  return (
    <tr
      data-testid="timeline-row"
      data-kind={entry.kind}
      data-incident={entry.incidentId}
      className={cn(
        entry.incidentId !== undefined && "border-l-2 border-l-cx-rose/60",
      )}
    >
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-cx-fg2">
        {formatLogTime(new Date(entry.timestamp), { milliseconds: true })}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "inline-block rounded-full border px-2 font-mono text-[11px] leading-5",
            TONE_CLASS[TONE_BY_KIND[entry.kind] ?? "neutral"],
          )}
        >
          {entry.kind}
        </span>
      </td>
      <td className="px-3 py-2 text-cx-fg2">{entry.connectorId ?? "—"}</td>
      <td className="px-3 py-2 text-cx-fg2">
        {entry.summary}
        {entry.runId !== undefined && (
          <Link
            to={buildRunUrl(entry.cpId, entry.runId)}
            className="ml-2 text-xs text-cx-accent hover:underline"
          >
            View run
          </Link>
        )}
      </td>
    </tr>
  );
});

/**
 * The charge point's operational timeline (#448): connection loss and
 * recovery, injected network faults, status changes, transactions,
 * authorization rejections and scenario runs, oldest first. Entries of one
 * network-fault incident are marked, and its `recovery_completed` summary
 * gives the recovery time; an entry attributed to a scenario run links to
 * the run history. Distinct from Session analysis, which rebuilds a session
 * from the OCPP log.
 */
const OperationalTimelinePanel: React.FC<OperationalTimelinePanelProps> = ({
  cpId,
}) => {
  const { page, isLoading, error, supported, refresh } =
    useOperationalTimeline(cpId);

  if (!supported) {
    return (
      <EmptyState
        title="Operational events unavailable"
        hint="This connection does not expose the operational timeline."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-xs text-cx-muted">
        <span>
          {page.total} event{page.total === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isLoading}
          className="inline-flex items-center gap-1 rounded-md border border-cx-border px-2 py-1 text-cx-fg2 hover:bg-cx-sub disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Refresh
        </button>
      </div>

      {error !== null ? (
        <p role="alert" className="text-sm text-cx-rose">
          Could not read the operational timeline: {error}
        </p>
      ) : !isLoading && page.entries.length === 0 ? (
        <EmptyState
          title="No operational events yet"
          hint="Connect the charge point, start a transaction or inject a network fault to see it recorded here."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-cx-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-cx-sub text-xs uppercase tracking-wide text-cx-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Connector</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cx-border">
              {page.entries.map((entry) => (
                <TimelineRow key={entry.seq} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default OperationalTimelinePanel;
