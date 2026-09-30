/** Placeholder version in package.json until the release tooling stamps it. */
const UNSTAMPED_VERSION = "0.0.0";

/**
 * The build identifier shown by both UIs (classic footer, issue #93; `/v3`
 * console sidebar, issue #364), resolved in one place so they cannot drift.
 *
 * Only tag-triggered builds (Docker / Tauri / CLI release) carry a semver. The
 * GitHub Pages deploy builds from `main`, so it stamps the short commit SHA
 * instead and we fall back to that — otherwise Pages would show no build
 * identifier at all. An unstamped dev build returns `null` so the UI never
 * shows a meaningless "v0.0.0".
 */
export function resolveBuildLabel(
  version: string,
  commit: string,
): string | null {
  if (version !== UNSTAMPED_VERSION) return `v${version}`;
  return commit || null;
}

/** {@link resolveBuildLabel} over the build-time defines (vite.config.ts). */
export function appBuildLabel(): string | null {
  return resolveBuildLabel(__APP_VERSION__, __APP_COMMIT__);
}
