import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for issue #127 (Docker 0.6.1 web console blank page).
//
// The OCPP 1.5 SOAP transport is daemon-only, but ChargePoint statically
// imports it, so without the browser-build stub in vite.config.ts the
// production bundle drags in xmlbuilder2's CommonJS DOM stack (@oozcitak/*).
// That CJS<->ESM interop crashes browser startup under some production
// module-init orderings with "Object.defineProperty called on non-object",
// blanking the whole SPA. The daemon-only unit tests never exercise the
// browser bundle, and PR CI never runs `vite build`, so nothing caught it.
// This test builds the real browser bundle and asserts that stack is absent.
//
// Runs under `bun test` (the `test:bun` npm script), NOT vitest: the vite stub
// is skipped when process.env.VITEST is set, so the assertion is only
// meaningful outside vitest.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// Identifiers unique to xmlbuilder2's @oozcitak DOM stack that survive
// minification. If any reaches a browser chunk, the daemon-only SOAP XML
// libraries leaked back into the web bundle and #127 can recur.
const FORBIDDEN = ["@oozcitak", "XMLBuilderCBImpl", "oozcitak/dom"];

describe("browser bundle (issue #127)", () => {
  it(
    "does not bundle the daemon-only xmlbuilder2 DOM stack",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "ocpp-bundle-check-"));
      try {
        // The vite stub keys off VITEST being unset; bun test doesn't set it,
        // but strip it defensively in case a parent runner did.
        const env = { ...process.env };
        delete env.VITEST;

        const proc = Bun.spawnSync(
          ["bunx", "vite", "build", "--outDir", outDir],
          { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
        );

        if (proc.exitCode !== 0) {
          console.error(proc.stderr.toString());
        }
        expect(proc.exitCode).toBe(0);

        const assetsDir = join(outDir, "assets");
        const jsFiles = readdirSync(assetsDir).filter((f) =>
          f.endsWith(".js"),
        );
        expect(jsFiles.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of jsFiles) {
          const code = readFileSync(join(assetsDir, file), "utf-8");
          for (const marker of FORBIDDEN) {
            if (code.includes(marker)) offenders.push(`${file}: ${marker}`);
          }
        }

        if (offenders.length > 0) {
          console.error(
            "Daemon-only SOAP XML code leaked into the browser bundle:\n" +
              offenders.join("\n"),
          );
        }
        expect(offenders).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
