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
    environmentMatchGlobs: [["**/*.dom.test.{ts,tsx}", "jsdom"]],
    setupFiles: ["src/test/setup.dom.ts"],
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
      // The OCPP 1.5 SOAP transport is daemon-only: it needs
      // `--soap-callback-url` and an inbound SOAP server the web console can't
      // run, so the browser never instantiates OCPPSoapHandler. But
      // ChargePoint statically imports it, so soapEnvelope.ts — and with it
      // xmlbuilder2's CommonJS DOM stack (@oozcitak/*, plus fast-xml-parser) —
      // lands in the browser bundle's static init graph anyway. That CJS<->ESM
      // interop crashes browser startup under some production module-init
      // orderings with "Object.defineProperty called on non-object", blanking
      // the whole SPA (issue #127; the earlier `events` polyfill only papered
      // over an earlier symptom of the same root cause). Alias both XML
      // libraries to a tiny stub for the browser build/dev server so that code
      // path is never bundled. Skipped under vitest (process.env.VITEST), where
      // the real SOAP code runs in Node.
      ...(process.env.VITEST
        ? {}
        : {
            xmlbuilder2: path.resolve(
              __dirname,
              "./src/build/soapXmlBrowserStub.ts",
            ),
            "fast-xml-parser": path.resolve(
              __dirname,
              "./src/build/soapXmlBrowserStub.ts",
            ),
          }),
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
