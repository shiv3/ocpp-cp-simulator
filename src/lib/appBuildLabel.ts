import {
  formatVersionLabel,
  resolveBuildVersion,
} from "@/protocol/buildVersion";

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

/** {@link resolveBuildLabel} over the build-time defines (vite.config.ts). */
export function appBuildLabel(): string {
  return resolveBuildLabel(__APP_VERSION__, __APP_COMMIT__);
}
