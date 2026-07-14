import React from "react";

import { cn } from "@/lib/utils";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

export type StatusPillStatus = OCPPStatus | "Connected" | "Disconnected";

type PillColor = "emerald" | "blue" | "amber" | "rose" | "gray";

// Full literal class strings per color bucket. Tailwind can only see class
// names that appear verbatim in source, so we can't build `bg-${color}-100`
// dynamically — each bucket lists its complete set.
const COLOR_CLASSES: Record<PillColor, string> = {
  emerald:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-950 dark:text-gray-300",
};

const STATUS_COLORS: Record<StatusPillStatus, PillColor> = {
  [OCPPStatus.Available]: "emerald",
  Connected: "emerald",
  [OCPPStatus.Charging]: "blue",
  [OCPPStatus.Preparing]: "amber",
  [OCPPStatus.Finishing]: "amber",
  [OCPPStatus.Reserved]: "amber",
  [OCPPStatus.SuspendedEV]: "amber",
  [OCPPStatus.SuspendedEVSE]: "amber",
  [OCPPStatus.Faulted]: "rose",
  [OCPPStatus.Unavailable]: "rose",
  Disconnected: "gray",
};

export interface StatusPillProps {
  status: StatusPillStatus;
  className?: string;
}

const StatusPill: React.FC<StatusPillProps> = ({ status, className }) => {
  const color = STATUS_COLORS[status] ?? "gray";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        COLOR_CLASSES[color],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
};

export default StatusPill;
