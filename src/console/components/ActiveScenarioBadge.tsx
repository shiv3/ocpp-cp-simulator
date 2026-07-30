import React from "react";

interface ActiveScenarioBadgeProps {
  /**
   * When true, show the "Scenario" badge in blue (running).
   * When false, don't render.
   */
  isActive: boolean;
  /**
   * Expectation description of the first run in "waiting" state among the
   * active runs (regardless of its position in the array). When provided,
   * show an amber waiting badge instead of the blue "Scenario" one.
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
      className={
        isWaiting
          ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300"
      }
    >
      {isWaiting ? `Waiting: ${waitingExpectation}` : "Scenario"}
    </span>
  );
};

export default ActiveScenarioBadge;
