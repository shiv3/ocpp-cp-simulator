import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";

// Surface the package version to the app (footer link, issue #93). Stays
// "0.0.0" in dev and is stamped by the release tooling; the footer hides it
// when unstamped.
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// The GitHub Pages deploy builds from `main`, not a tag, so there is no semver
// to stamp into package.json (`npm version` only takes semver anyway). It sets
// APP_COMMIT instead and the footer falls back to the short SHA, which is what
// actually identifies a rolling deploy. Truncated here rather than in the
// workflow because GitHub expressions can't substring `github.sha`.
const appCommit = (process.env.APP_COMMIT ?? "").slice(0, 7);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
    setupFiles: ["src/test/setup.dom.ts"],
    // In CI, also emit a JUnit report next to coverage so it can be uploaded
    // to Codecov (test analytics / flaky-test surfacing, issue #131). Local
    // runs keep the plain default reporter.
    reporters: process.env.CI ? ["default", "junit"] : "default",
    outputFile: { junit: "./coverage/junit.xml" },
    // bun:sqlite is a runtime built-in that vite can't resolve. Tests
    // ending in `.bun.test.ts` run under `bun test` instead (see the
    // `test:bun` npm script); skip them here.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.bun.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
