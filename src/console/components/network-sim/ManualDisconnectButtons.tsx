import React, { useState } from "react";

export interface ManualDisconnectButtonsProps {
  manualRuleIds: string[];
  isConnected: boolean;
  onTriggerDisconnect: (
    ruleId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Renders one button per manual rule ID, with:
 * - Label: "Force disconnect: <ruleId>"
 * - Disabled when CP is not connected, with a reason
 * - On click: calls onTriggerDisconnect(ruleId)
 * - Surfaces errors inline if the call fails
 * - Guards against double-clicks with pending state
 */
const ManualDisconnectButtons: React.FC<ManualDisconnectButtonsProps> = ({
  manualRuleIds,
  isConnected,
  onTriggerDisconnect,
}) => {
  // Track pending state and errors per rule ID
  const [pendingRules, setPendingRules] = useState<Set<string>>(new Set());
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});

  if (manualRuleIds.length === 0) {
    return null;
  }

  const handleClick = async (ruleId: string) => {
    if (pendingRules.has(ruleId)) {
      return; // Already pending
    }

    setPendingRules((prev) => new Set(prev).add(ruleId));
    setRuleErrors((prev) => {
      const next = { ...prev };
      delete next[ruleId];
      return next;
    });

    try {
      const result = await onTriggerDisconnect(ruleId);
      if (!result.ok) {
        setRuleErrors((prev) => ({
          ...prev,
          [ruleId]: result.error,
        }));
      }
    } catch (err) {
      setRuleErrors((prev) => ({
        ...prev,
        [ruleId]: err instanceof Error ? err.message : "Unknown error",
      }));
    } finally {
      setPendingRules((prev) => {
        const next = new Set(prev);
        next.delete(ruleId);
        return next;
      });
    }
  };

  return (
    <div className="space-y-3">
      {manualRuleIds.map((ruleId) => {
        const isPending = pendingRules.has(ruleId);
        const error = ruleErrors[ruleId];

        return (
          <div key={ruleId}>
            <button
              type="button"
              disabled={!isConnected || isPending}
              onClick={() => void handleClick(ruleId)}
              title={
                !isConnected
                  ? "Charge point is not connected"
                  : isPending
                    ? "Triggering disconnect..."
                    : undefined
              }
              className="rounded-md border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-amber-900 dark:text-amber-300 dark:hover:bg-amber-950"
              data-testid={`disconnect-btn-${ruleId}`}
            >
              {isPending ? "Triggering…" : `Force disconnect: ${ruleId}`}
            </button>
            {error && (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ManualDisconnectButtons;
