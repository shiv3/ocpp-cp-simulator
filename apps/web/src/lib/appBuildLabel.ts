import {
  formatVersionLabel,
  resolveBuildVersion,
} from "@ocpp-cp-simulator/contracts/buildVersion";

/**
 * The web console's own build identifier (classic footer, issue #93; web
 * console sidebar, issue #364), resolved in one place so they cannot drift.
 *
 * Only tag-triggered builds (Docker / Tauri / CLI release) carry a semver and
 * show `v1.2.3`. A deployed build off a branch (GitHub Pages, GHCR `main`
 * image) stamps the commit and shows `<sha7>-dev`; an unstamped local build
 * shows `local-dev`. Same rule as the daemon's `appVersion()`.
 */
export function resolveBuildLabel(version: string, commit: string): string {
  return formatVersionLabel(
    resolveBuildVersion({ packageVersion: version, commit }),
  );
}

/** The bare version the daemon's `appVersion()` would report for this build
 *  (`1.2.3`, `<sha7>-dev` or `local-dev`): stamped on scenario run reports. */
export function appVersionString(): string {
  return resolveBuildVersion({
    packageVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "",
    commit: typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "",
  });
}

/** {@link resolveBuildLabel} over the build-time defines (vite.config.ts). */
export function appBuildLabel(): string {
  return resolveBuildLabel(__APP_VERSION__, __APP_COMMIT__);
}
