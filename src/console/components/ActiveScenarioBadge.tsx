import React from "react";

interface ActiveScenarioBadgeProps {
  /**
   * When true, show the "Scenario" badge in blue (running).
   * When false, don't render.
   */
  isActive: boolean;
  /**
   * When provided and the first run's state is "waiting", show an amber
   * badge with the expectation description instead of blue "Scenario".
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
