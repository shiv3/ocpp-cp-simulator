import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

export type StatusPillStatus = OCPPStatus | "Connected" | "Disconnected";

export type StatusColor = "emerald" | "blue" | "amber" | "rose" | "gray";

const STATUS_COLORS: Record<StatusPillStatus, StatusColor> = {
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

/** The color bucket of a status: the pill, the dots and the icons of the
 *  Charge Points list all read it, so one status is one color everywhere. */
export function statusColor(status: StatusPillStatus): StatusColor {
  return STATUS_COLORS[status] ?? "gray";
}

// Full literal class strings per bucket: Tailwind only sees class names that
// appear verbatim in source, so `bg-${color}-500` cannot be built.
export const STATUS_PILL_CLASSES: Record<StatusColor, string> = {
  emerald:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-950 dark:text-gray-300",
};

const STATUS_DOT_CLASSES: Record<StatusColor, string> = {
  emerald: "bg-emerald-500 dark:bg-emerald-400",
  blue: "bg-blue-500 dark:bg-blue-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  rose: "bg-rose-500 dark:bg-rose-400",
  gray: "bg-gray-400 dark:bg-gray-500",
};

const STATUS_TEXT_CLASSES: Record<StatusColor, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  blue: "text-blue-600 dark:text-blue-400",
  amber: "text-amber-600 dark:text-amber-400",
  rose: "text-rose-600 dark:text-rose-400",
  gray: "text-gray-400 dark:text-gray-500",
};

/** `bg-*` class of a status dot. */
export function statusDotClass(status: StatusPillStatus): string {
  return STATUS_DOT_CLASSES[statusColor(status)];
}

/** `text-*` class for an icon that carries a status. */
export function statusTextClass(status: StatusPillStatus): string {
  return STATUS_TEXT_CLASSES[statusColor(status)];
}
