import React, { useMemo } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

import { useStateHistory } from "@/data/hooks/useStateHistory";
import type { HistoryOptions } from "@/cp/application/services/types/StateSnapshot";

import EmptyState from "../../components/EmptyState";

export interface TransactionsTabProps {
  cpId: string;
}

/**
 * Transaction history table for a CP: every `transitionType: "transaction"`
 * entry from `useStateHistory`, across all connectors. `historyOptions` is
 * memoized (mirrors `StateTransitionViewer`'s own usage of the hook) — the
 * hook's effect depends on it by reference, so a fresh object every render
 * would refetch in a loop.
 */
const TransactionsTab: React.FC<TransactionsTabProps> = ({ cpId }) => {
  const historyOptions = useMemo<HistoryOptions>(
    () => ({ transitionType: "transaction" }),
    [],
  );
  const { history, isLoading } = useStateHistory(cpId, { historyOptions });

  if (!isLoading && history.length === 0) {
    return (
      <EmptyState
        title="No transaction history"
        hint="Start a transaction on a connector to see it recorded here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-cx-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-cx-sub text-xs uppercase tracking-wide text-cx-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Connector</th>
            <th className="px-3 py-2 font-medium">Transition</th>
            <th className="px-3 py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-cx-border">
          {history.map((entry) => (
            <tr key={entry.id}>
              <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                {entry.timestamp.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-cx-fg2">{entry.entityId ?? "—"}</td>
              <td className="px-3 py-2 text-cx-fg2">
                {entry.fromState} → {entry.toState}
              </td>
              <td className="px-3 py-2">
                {entry.success ? (
                  <CheckCircle2
                    className="h-4 w-4 text-cx-emerald"
                    aria-label="success"
                  />
                ) : (
                  <XCircle
                    className="h-4 w-4 text-cx-rose"
                    aria-label="failed"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default TransactionsTab;
