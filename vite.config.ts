import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// Surface the package version to the app (footer link, issue #93). Stays
// "0.0.0" in dev and is stamped by the release tooling; the footer hides it
// when unstamped.
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_URL || "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
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
  },
});
