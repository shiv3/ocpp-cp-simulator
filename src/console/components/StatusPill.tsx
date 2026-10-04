import React from "react";

import { cn } from "@/lib/utils";
import {
  STATUS_PILL_CLASSES,
  statusColor,
  type StatusPillStatus,
} from "./statusColor";

export type { StatusPillStatus };

export interface StatusPillProps {
  status: StatusPillStatus;
  className?: string;
}

const StatusPill: React.FC<StatusPillProps> = ({ status, className }) => {
  const color = statusColor(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_PILL_CLASSES[color],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
};

export default StatusPill;
