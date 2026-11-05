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
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-cx-fg2",
        className,
      )}
      title="Network simulation enabled"
      aria-label="Network simulation enabled"
    >
      <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-cx-purple" />
      Net sim
    </span>
  );
};

export default NetworkSimBadge;
