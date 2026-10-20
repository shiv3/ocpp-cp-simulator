import React from "react";

import { cn } from "@/lib/utils";
import {
  LIVE_RUN_STATE_STYLES,
  type LiveRunState,
} from "../lib/scenarioRunState";

export type RunStatePillState =
  LiveRunState | "idle" | "completed" | "stopped" | "error";

// Live states share one map with the list views; the run page and the history
// list also show the states a run has before and after it is live.
const DOT_CLASSES: Record<RunStatePillState, string> = {
  ...LIVE_RUN_STATE_STYLES,
  idle: "bg-cx-gray",
  stopped: "bg-cx-gray",
  completed: "bg-cx-emerald",
  error: "bg-cx-rose",
};

export interface RunStatePillProps {
  state: RunStatePillState;
  /** Text instead of the lowercase state name (the run page capitalizes). */
  label?: string;
  /** Extra text after the state, e.g. the step counter. */
  children?: React.ReactNode;
  className?: string;
  title?: string;
}

/** A scenario run state as a colored dot plus lowercase text, like StatusPill. */
const RunStatePill: React.FC<RunStatePillProps> = ({
  state,
  label,
  children,
  className,
  title,
}) => (
  <span
    title={title}
    className={cn(
      "inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-cx-fg2",
      className,
    )}
  >
    <span
      aria-hidden
      className={cn("h-[7px] w-[7px] rounded-full", DOT_CLASSES[state])}
    />
    {label ?? state}
    {children}
  </span>
);

export default RunStatePill;
