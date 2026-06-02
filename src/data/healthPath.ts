// URL path the browser uses for daemon health checks:
//   * DataProvider auto-detects Remote mode by probing this path at the
//     page origin (a 2xx with `{ ok: true }` means a daemon is on the
//     other end).
//   * Navbar polls the same path via RemoteChargePointService.ping() to
//     show the green/red connection dot while in Remote mode.
//
// Must match the daemon's `--health-path` flag (default `/v1/healthz`).
// Override at UI build time via `VITE_HEALTH_PATH=/custom/path` when the
// daemon is deployed behind a proxy that reserves the default path —
// e.g. Google Front End in front of Cloud Run returns 404 for certain
// reserved paths before the request ever reaches the container.

const DEFAULT_HEALTH_PATH = "/v1/healthz";

function readBuildTimeHealthPath(): string | null {
  if (typeof import.meta === "undefined") return null;
  const meta = import.meta as unknown;
  if (typeof meta !== "object" || meta === null || !("env" in meta)) {
    return null;
  }
  const env = (meta as { env?: Record<string, unknown> }).env;
  const raw = env?.VITE_HEALTH_PATH;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

export const HEALTH_PATH: string =
  readBuildTimeHealthPath() ?? DEFAULT_HEALTH_PATH;
