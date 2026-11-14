import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import license from "rollup-plugin-license";
import { renderNotices } from "./scripts/licenseNotices";

// Surface the package version to the app (footer link, issue #93). Stays
// "0.0.0" in dev and is stamped by the release tooling; unstamped, the label
// falls back to the commit, then to "local-dev" (packages/contracts/src/buildVersion.ts).
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// The GitHub Pages deploy and the GHCR branch images build from `main`, not a
// tag, so there is no semver to stamp into package.json (`npm version` only
// takes semver anyway). They set APP_COMMIT (the full `github.sha`) instead and
// the label reads `<sha7>-dev`, which is what actually identifies a rolling
// deploy. resolveBuildVersion truncates it, shared with the daemon side.
const appCommit = process.env.APP_COMMIT ?? "";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // MIT / ISC ask that the copyright and permission notice travel with every
    // copy that carries the code, and the bundle inlines React, Lucide and the
    // rest (#857). The notices file sits in dist/, so the npm tarball (`files`),
    // the Docker image (COPY dist) and the Tauri app (frontendDist) all ship it.
    license({
      thirdParty: {
        output: {
          file: path.resolve(__dirname, "dist/THIRD-PARTY-LICENSES.txt"),
          template: (dependencies) =>
            renderNotices(
              [...dependencies].map((d) => ({
                name: d.name ?? "",
                version: d.version ?? "",
                license: d.license,
                licenseText: d.licenseText,
                repository: d.repository,
                author: d.author?.text(),
              })),
            ),
        },
      },
    }),
  ],
  // Absolute base so the SPA's deep nested routes (e.g. /cp/:id,
  // /scenarios/edit) resolve their /assets/* references from the server root
  // on a hard load / refresh / shared link. A relative "./" base resolves
  // assets against the current route path (/cp/CP001 -> /cp/assets/... -> 404,
  // blank page). GitHub Pages sets VITE_BASE_URL to its subpath explicitly;
  // the daemon (--web-console), Docker, and Tauri all serve from root, and the
  // daemon already SPA-falls-back extensionless paths to index.html.
  base: process.env.VITE_BASE_URL || "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_COMMIT__: JSON.stringify(appCommit),
  },
  // The Tauri dev shell pins its devUrl to this port; if some unrelated
  // Vite server already holds 5173 we don't want to silently float to
  // 5174/5175 because Tauri would then end up loading the wrong app.
  // `strictPort` makes the failure loud so the conflict is obvious.
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "node",
    // vitest 4 removed environmentMatchGlobs; the dom tests select jsdom via a
    // `// @vitest-environment jsdom` docblock instead.
    setupFiles: ["apps/web/src/test/setup.dom.ts"],
    // In CI, also emit a JUnit report next to coverage so it can be uploaded
    // to Codecov (test analytics / flaky-test surfacing, issue #131). Local
    // runs keep the plain default reporter.
    reporters: process.env.CI ? ["default", "junit"] : "default",
    outputFile: { junit: "./coverage/junit.xml" },
    // bun:sqlite is a runtime built-in that vite can't resolve. Tests
    // ending in `.bun.test.ts` run under `bun test` instead (see the
    // `test:bun` npm script); skip them here.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.bun.test.ts",
      // isolated spikes with their own install (#936), run by hand
      "apps/web/spikes/**",
      // standalone Bun reproductions (#833), run by hand with `bun test`
      "repro/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./apps/web/src"),
    },
    // Force a single React instance across every chunk. The Scenario Editor is
    // a lazy chunk built around @xyflow/react, which leans heavily on React
    // context/hooks. If the production build ever splits React such that the
    // lazy chunk resolves a second copy, those hooks read a null dispatcher and
    // throw React error #321 ("invalid hook call / more than one copy of
    // React"), crashing the editor. Deduping pins react/react-dom to one
    // module so the lazy chunk and the app share the same instance.
    dedupe: ["react", "react-dom"],
  },
});
