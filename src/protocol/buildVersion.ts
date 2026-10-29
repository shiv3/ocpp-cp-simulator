/**
 * The build version rule shared by the daemon (`appVersion()`, reported over
 * `server.info`, `/v1/healthz`, MCP and `scenario_report`) and the web console
 * label (`appBuildLabel()`), so the two sides of the same image cannot drift.
 * It lives in `src/protocol` because that tree ships in both the browser
 * bundle and the daemon's runtime image; `src/lib` does not reach the latter.
 *
 * Only tag-triggered builds carry a semver. A deployed build off a branch
 * (GHCR `main` image, GitHub Pages) stamps the commit instead and reads as
 * `<sha7>-dev`; a build with nothing stamped is a local one, `local-dev`.
 */

/** Placeholder version in package.json until the release tooling stamps it. */
export const UNSTAMPED_VERSION = "0.0.0";
/** The version of a build with neither a semver nor a commit stamped. */
export const LOCAL_DEV_VERSION = "local-dev";

const SHORT_SHA_LENGTH = 7;
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

/**
 * Resolution order:
 *   1. `explicit` — an operator stamp (the daemon's `APP_VERSION`).
 *   2. `packageVersion`, unless it is still the `0.0.0` placeholder.
 *   3. `commit` → `<sha7>-dev`, for a deployed build off a branch.
 *   4. `local-dev`.
 * Blank or whitespace values count as absent: Docker turns an unset build arg
 * into an empty `ENV APP_COMMIT=`.
 */
export function resolveBuildVersion(input: {
  explicit?: string;
  packageVersion?: string;
  commit?: string;
}): string {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;

  const packageVersion = input.packageVersion?.trim();
  if (packageVersion && packageVersion !== UNSTAMPED_VERSION) {
    return packageVersion;
  }

  const commit = input.commit?.trim();
  if (commit) return `${commit.slice(0, SHORT_SHA_LENGTH)}-dev`;

  return LOCAL_DEV_VERSION;
}

/** Display form: `v1.2.3` for a semver, the raw value otherwise — a short SHA
 *  such as `1234567-dev` can start with a digit but is not a release. */
export function formatVersionLabel(version: string): string {
  return SEMVER_PREFIX.test(version) ? `v${version}` : version;
}
