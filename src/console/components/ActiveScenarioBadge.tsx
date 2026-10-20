import React from "react";

import { cn } from "@/lib/utils";

interface ActiveScenarioBadgeProps {
  /**
   * When true, show the "Scenario" badge with a blue dot (running).
   * When false, don't render.
   */
  isActive: boolean;
  /**
   * Expectation description of the first run in "waiting" state among the
   * active runs (regardless of its position in the array). When provided,
   * show an amber-dot waiting badge instead of the blue "Scenario" one.
   */
  waitingExpectation?: string | null;
}

const ActiveScenarioBadge: React.FC<ActiveScenarioBadgeProps> = ({
  isActive,
  waitingExpectation,
}) => {
  if (!isActive) {
    return null;
  }

  const isWaiting = !!waitingExpectation;

  return (
    <span
      title={
        isWaiting ? `Waiting for ${waitingExpectation}` : "Scenario running"
      }
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-cx-fg2"
    >
      <span
        aria-hidden
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          isWaiting ? "bg-cx-amber" : "bg-cx-blue",
        )}
      />
      {isWaiting ? `Waiting: ${waitingExpectation}` : "Scenario"}
    </span>
  );
};

export default ActiveScenarioBadge;
