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
      // The OCPP 1.5 SOAP transport (daemon-only) pulls in xmlbuilder2, whose
      // streaming builder declares `class XMLBuilderCBImpl extends
      // require("events").EventEmitter` at module load. That code is never
      // executed in the browser web console, but it is statically reachable
      // from the shared ChargePoint domain class and therefore bundled. Vite
      // externalizes Node's `events` for the browser, leaving EventEmitter
      // undefined, so the class declaration throws "Class extends value
      // undefined" while the bundle initializes — blanking the whole console.
      // Resolve `events` to its browser polyfill (the `events` npm package) so
      // the otherwise-unused module evaluates cleanly. Keep the `events`
      // devDependency in sync; it has no direct import and exists only for this.
      events: path.resolve(__dirname, "node_modules/events/events.js"),
    },
  },
});
