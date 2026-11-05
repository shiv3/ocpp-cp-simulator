import React from "react";

import { cn } from "@/lib/utils";
import {
  statusColor,
  statusDotClass,
  type StatusPillStatus,
} from "./statusColor";

export type { StatusPillStatus };

export interface StatusPillProps {
  status: StatusPillStatus;
  className?: string;
}

/** A status as a small colored dot plus plain text, with no fill. */
const StatusPill: React.FC<StatusPillProps> = ({ status, className }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium",
      statusColor(status) === "gray" ? "text-cx-muted" : "text-cx-fg2",
      className,
    )}
  >
    <span
      aria-hidden
      className={cn("h-[7px] w-[7px] rounded-full", statusDotClass(status))}
    />
    {status}
  </span>
);

export default StatusPill;
