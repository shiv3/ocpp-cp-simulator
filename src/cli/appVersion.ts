import pkg from "../../package.json";
import { resolveBuildVersion } from "../protocol/buildVersion";

/**
 * The simulator version to report at runtime.
 *
 * Release images used to say `0.0.0` everywhere — `scenario_report`'s
 * `simulatorVersion`, the MCP `serverInfo.version` — because both were
 * hard-coded literals matching package.json's unstamped placeholder. That made
 * a report from a GHCR release indistinguishable from one off a dev checkout.
 *
 * The release workflows run `npm version --no-git-tag-version` before building
 * (.github/workflows/docker-publish.yml, release.yml), and the runtime image
 * copies package.json (Dockerfile), so a released artifact's package.json
 * carries the real semver. A branch image gets the commit instead through the
 * `APP_COMMIT` build arg, which the Dockerfile re-exports as a runtime env.
 * The CLI runs from source under bun, so there is no bundler `define` to hook —
 * read both at runtime instead.
 *
 * Resolution order (see resolveBuildVersion):
 *   1. `APP_VERSION` — an explicit stamp, for callers that build the image
 *      without going through `npm version`.
 *   2. package.json's `version`, unless it is still the `0.0.0` placeholder.
 *   3. `APP_COMMIT` → `<sha7>-dev` — a deployed build off a branch.
 *   4. `local-dev` — nothing stamped, said out loud rather than reported as a
 *      real release.
 */
export function appVersion(): string {
  // Read on every call so a process that sets the env late (or a test) isn't
  // stuck with an import-time snapshot.
  const packageVersion = (pkg as { version?: unknown }).version;
  return resolveBuildVersion({
    explicit: process.env.APP_VERSION,
    packageVersion:
      typeof packageVersion === "string" ? packageVersion : undefined,
    commit: process.env.APP_COMMIT,
  });
}
