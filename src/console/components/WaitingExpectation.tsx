import React from "react";

import type { ScenarioExpectation } from "../../cp/application/scenario/ScenarioTypes";
import {
  describeExpectation,
  formatElapsed,
  remainingWaitMs,
} from "../lib/scenarioExpectation";

export interface WaitingExpectationProps {
  expectation: ScenarioExpectation;
  currentNodeStartedAt: number | null;
  /** Current time (ms) — the caller ticks it so the countdown moves. */
  now: number;
  className?: string;
}

/** "Waiting for `<action>`" plus the remaining timeout of a parked scenario
 *  node — shared by the CP page's Active scenarios panel and the run page. */
const WaitingExpectation: React.FC<WaitingExpectationProps> = ({
  expectation,
  currentNodeStartedAt,
  now,
  className,
}) => {
  const remaining = remainingWaitMs(expectation, currentNodeStartedAt, now);
  return (
    <div className={className ?? "flex flex-col gap-1 text-xs"}>
      <div>
        Waiting for{" "}
        <code className="font-mono text-xs bg-gray-200 px-1 py-0.5 rounded dark:bg-gray-700">
          {describeExpectation(expectation)}
        </code>
      </div>
      {remaining !== null ? (
        <div>Timeout in {formatElapsed(remaining)}</div>
      ) : (
        <div>No timeout</div>
      )}
    </div>
  );
};

export default WaitingExpectation;
