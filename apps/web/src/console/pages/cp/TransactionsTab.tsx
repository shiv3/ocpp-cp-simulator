import { useTranslation } from "react-i18next";
import React from "react";

import { cn } from "@/lib/utils";
import type { MessageKey } from "@/i18n";
import { formatEnergyKwh, formatSessionDuration } from "@/lib/connectorFormat";
import type { ChargingSessionOutcome } from "@ocpp-cp-sim/core/cp/domain/session/ChargingSession";

import EmptyState from "../../components/EmptyState";
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

const OUTCOME_KEY: Record<ChargingSessionOutcome, MessageKey> = {
  active: "cp.transactions.outcome.active",
  completed: "cp.transactions.outcome.completed",
  interrupted: "cp.transactions.outcome.interrupted",
  failed: "cp.transactions.outcome.failed",
};

const DASH = "—";

/**
 * Charging-session history of a CP (#447): one row per transaction, newest
 * first, the same columns for every OCPP version. A value the simulator does
 * not know (an active session's end, a 1.6 id the CSMS never assigned) shows
 * as a dash, never a guess.
 */
const TransactionsTab: React.FC<TransactionsTabProps> = ({ cpId }) => {
  const { t } = useTranslation();
  const { page, isLoading, error } = useChargingSessions(cpId);

  if (error) {
    return <EmptyState title={t("cp.transactions.loadFailed")} hint={error} />;
  }

  if (!isLoading && page.sessions.length === 0) {
    return (
      <EmptyState
        title={t("cp.transactions.empty")}
        hint={t("cp.transactions.emptyHint")}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-cx-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-cx-sub text-xs uppercase tracking-wide text-cx-muted">
          <tr>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.started")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.connector")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.transaction")}
            </th>
            <th className="px-3 py-2 font-medium">idTag</th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.duration")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.energy")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.stopReason")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.transactions.outcome")}
            </th>
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
                  : formatSessionDuration(session.durationMs)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {session.energyWh === null
                  ? DASH
                  : formatEnergyKwh(session.energyWh)}
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
                      ? t("cp.transactions.csmsAnswered", {
                          status: session.authorizationStatus,
                        })
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
                  {t(OUTCOME_KEY[session.outcome])}
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
