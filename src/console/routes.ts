/**
 * The new console is mounted under `/v3` (see `App.tsx`), alongside the
 * classic UI at `/v2`. The console's own route definitions stay root-relative
 * (`/`, `/cp/:cpId`, …) because they're matched as descendant routes under
 * `/v3/*`, but every in-app link/navigate must carry the `/v3` prefix so it
 * resolves to the console rather than the classic UI. Build those paths with
 * `consolePath()` instead of hard-coding the prefix.
 */
export const CONSOLE_BASENAME = "/v3";

/**
 * Prefixes a console-internal path (which may include a query string) with
 * the console basename. `consolePath("/")` → `/v3`, `consolePath("/logs")` →
 * `/v3/logs`, `consolePath("/scenarios?cp=x")` → `/v3/scenarios?cp=x`.
 *
 * Do NOT use this for cross-app links (e.g. back to the classic UI at `/v2`);
 * those are absolute and live outside the console.
 */
export function consolePath(sub = "/"): string {
  if (!sub || sub === "/") return CONSOLE_BASENAME;
  return `${CONSOLE_BASENAME}${sub.startsWith("/") ? sub : `/${sub}`}`;
}
