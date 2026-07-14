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
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Connector</th>
            <th className="px-3 py-2 font-medium">Transition</th>
            <th className="px-3 py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {history.map((entry) => (
            <tr key={entry.id}>
              <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
                {entry.timestamp.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                {entry.entityId ?? "—"}
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                {entry.fromState} → {entry.toState}
              </td>
              <td className="px-3 py-2">
                {entry.success ? (
                  <CheckCircle2
                    className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                    aria-label="success"
                  />
                ) : (
                  <XCircle
                    className="h-4 w-4 text-rose-600 dark:text-rose-400"
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
