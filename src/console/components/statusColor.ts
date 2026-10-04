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
// appear verbatim in source, so `bg-cx-${color}` cannot be built. The tokens
// switch with the theme, so there is no `dark:` twin.
const STATUS_DOT_CLASSES: Record<StatusColor, string> = {
  emerald: "bg-cx-emerald",
  blue: "bg-cx-blue",
  amber: "bg-cx-amber",
  rose: "bg-cx-rose",
  gray: "bg-cx-gray",
};

const STATUS_TEXT_CLASSES: Record<StatusColor, string> = {
  emerald: "text-cx-emerald",
  blue: "text-cx-blue",
  amber: "text-cx-amber",
  rose: "text-cx-rose",
  gray: "text-cx-gray",
};

/** `bg-*` class of a status dot. */
export function statusDotClass(status: StatusPillStatus): string {
  return STATUS_DOT_CLASSES[statusColor(status)];
}

/** `text-*` class for an icon that carries a status. */
export function statusTextClass(status: StatusPillStatus): string {
  return STATUS_TEXT_CLASSES[statusColor(status)];
}
