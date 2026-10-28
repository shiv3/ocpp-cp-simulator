import React from "react";

import { cn } from "@/lib/utils";
import type { ChargingSessionOutcome } from "@/cp/domain/session/ChargingSession";

import EmptyState from "../../components/EmptyState";
import { formatElapsed } from "../../lib/scenarioExpectation";
import { useChargingSessions } from "../../lib/useChargingSessions";

export interface TransactionsTabProps {
  cpId: string;
}

const OUTCOME_DOT: Record<ChargingSessionOutcome, string> = {
  active: "bg-cx-blue",
  completed: "bg-cx-emerald",
  interrupted: "bg-cx-amber",
  failed: "bg-cx-rose",
};

const DASH = "—";

function formatEnergy(wh: number | null): string {
  return wh === null ? DASH : `${(wh / 1000).toFixed(2)} kWh`;
}

/**
 * Charging-session history of a CP (#447): one row per transaction, newest
 * first, the same columns for every OCPP version. A value the simulator does
 * not know (an active session's end, a 1.6 id the CSMS never assigned) shows
 * as a dash, never a guess.
 */
const TransactionsTab: React.FC<TransactionsTabProps> = ({ cpId }) => {
  const { page, isLoading, error } = useChargingSessions(cpId);

  if (error) {
    return (
      <EmptyState title="Could not load the charging sessions" hint={error} />
    );
  }

  if (!isLoading && page.sessions.length === 0) {
    return (
      <EmptyState
        title="No charging session yet"
        hint="Start a transaction on a connector to see it recorded here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-cx-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-cx-sub text-xs uppercase tracking-wide text-cx-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 font-medium">Connector</th>
            <th className="px-3 py-2 font-medium">Transaction</th>
            <th className="px-3 py-2 font-medium">idTag</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Energy</th>
            <th className="px-3 py-2 font-medium">Stop reason</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-cx-border">
          {page.sessions.map((session) => (
            <tr
              key={session.sessionId}
              data-testid="session-row"
              data-outcome={session.outcome}
            >
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {new Date(session.startedAt).toLocaleString()}
              </td>
              <td className="px-3 py-2 text-cx-fg2">{session.connectorId}</td>
              <td
                className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs text-cx-fg2"
                title={session.transactionId ?? undefined}
              >
                {session.transactionId ?? DASH}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {session.idTag ?? DASH}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {session.durationMs === null
                  ? DASH
                  : formatElapsed(session.durationMs)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {formatEnergy(session.energyWh)}
              </td>
              <td
                className="px-3 py-2 text-cx-fg2"
                title={session.triggerReason ?? undefined}
              >
                {session.stopReason ?? DASH}
              </td>
              <td className="px-3 py-2">
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-cx-fg2"
                  title={
                    session.authorizationStatus
                      ? `CSMS answered ${session.authorizationStatus}`
                      : undefined
                  }
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-[7px] w-[7px] rounded-full",
                      OUTCOME_DOT[session.outcome],
                    )}
                  />
                  {session.outcome}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default TransactionsTab;
