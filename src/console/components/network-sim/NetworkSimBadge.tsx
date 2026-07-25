import React from "react";

import { cn } from "@/lib/utils";

export interface NetworkSimBadgeProps {
  summary?: { enabled: boolean; manualRuleIds: string[] } | null;
  className?: string;
}

/**
 * Renders a small badge indicating network simulation is enabled.
 * Hidden when summary is null/undefined or summary.enabled is false.
 * Uses matching violet accent styling as .log-network-sim.
 */
const NetworkSimBadge: React.FC<NetworkSimBadgeProps> = ({
  summary,
  className,
}) => {
  // Render nothing if summary is null/undefined or not enabled
  if (!summary || !summary.enabled) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
        className,
      )}
      title="Network simulation enabled"
      aria-label="Network simulation enabled"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      Net sim
    </span>
  );
};

export default NetworkSimBadge;
