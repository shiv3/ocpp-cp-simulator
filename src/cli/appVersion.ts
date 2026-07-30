import pkg from "../../package.json";

/**
 * The simulator version to report at runtime.
 *
 * Release images used to say `0.0.0` everywhere — `scenario_report`'s
 * `simulatorVersion`, the MCP `serverInfo.version` — because both were
 * hard-coded literals matching package.json's unstamped placeholder. That made
 * a report from a GHCR release indistinguishable from one off a dev checkout.
 *
 * No build plumbing is needed to fix it: the release workflows already run
 * `npm version --no-git-tag-version` before building
 * (.github/workflows/docker-publish.yml, release.yml), and the runtime image
 * copies package.json (Dockerfile), so a released artifact's package.json
 * already carries the real semver. The CLI runs from source under bun, so
 * there is no bundler `define` to hook — read it at runtime instead.
 *
 * Resolution order:
 *   1. `APP_VERSION` — an explicit stamp, for callers that build the image
 *      without going through `npm version`.
 *   2. package.json's `version`, unless it is still the `0.0.0` placeholder.
 *   3. `0.0.0-dev` — an unstamped build, said out loud rather than reported as
 *      a real release.
 */
export const UNSTAMPED_VERSION = "0.0.0";
export const DEV_VERSION = "0.0.0-dev";

/** Resolve the version. Reads the environment on every call so a process that
 *  sets APP_VERSION late (or a test) isn't stuck with an import-time snapshot. */
export function appVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const fromPackage = (pkg as { version?: unknown }).version;
  if (typeof fromPackage === "string") {
    const trimmed = fromPackage.trim();
    if (trimmed && trimmed !== UNSTAMPED_VERSION) return trimmed;
  }

  return DEV_VERSION;
}
