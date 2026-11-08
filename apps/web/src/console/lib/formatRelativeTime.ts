import { t } from "../../i18n";

/** "never", "just now", "42s ago", "3m ago", "2h ago", "5d ago". */
export function formatRelativeTime(date: Date | null): string {
  if (!date) return t("common.time.never");
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 5) return t("common.time.justNow");
  if (diffSec < 60) return t("common.time.secondsAgo", { count: diffSec });
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t("common.time.minutesAgo", { count: diffMin });
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return t("common.time.hoursAgo", { count: diffHour });
  const diffDay = Math.round(diffHour / 24);
  return t("common.time.daysAgo", { count: diffDay });
}
