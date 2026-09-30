import React, { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import type { ScenarioExpectation } from "../../cp/application/scenario/ScenarioTypes";
import {
  describeExpectation,
  formatElapsed,
  remainingWaitMs,
} from "../lib/scenarioExpectation";

export interface WaitingExpectationProps {
  expectation: ScenarioExpectation;
  currentNodeStartedAt: number | null;
  /** #240: the runtime's deadline for the wait, when reported. */
  waitDeadlineAt?: number | null;
  /** Current time (ms) from a caller that already ticks one. Omitted, the
   *  component ticks its own — and only while the countdown can move, so
   *  the second-by-second re-render stays local to it. */
  now?: number;
  className?: string;
}

/** "Waiting for `<action>`" plus the remaining timeout of a parked scenario
 *  node — shared by the CP page's Active scenarios panel and the run page. */
const WaitingExpectation: React.FC<WaitingExpectationProps> = ({
  expectation,
  currentNodeStartedAt,
  waitDeadlineAt,
  now,
  className,
}) => {
  const [ownNow, setOwnNow] = useState<number>(Date.now());
  const countdownMoves =
    now === undefined &&
    (waitDeadlineAt != null ||
      (Boolean(expectation.timeoutMs) && currentNodeStartedAt != null));

  useEffect(() => {
    if (!countdownMoves) return undefined;
    setOwnNow(Date.now());
    const interval = setInterval(() => setOwnNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [countdownMoves]);

  const remaining = remainingWaitMs(
    expectation,
    currentNodeStartedAt,
    now ?? ownNow,
    waitDeadlineAt,
  );
  return (
    <div className={cn("flex flex-col gap-1", className)}>
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
