import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end spawn test for the `analyze` subcommand (issue #188 Track 3):
// exercises the real CLI entry point (src/cli/main.ts's top-of-main()
// dispatch), not just runAnalyze() in-process, so a wiring regression in
// main.ts (argv parsing, process.exit() codes) is caught even though every
// other analyze test calls runAnalyze()/parseAnalyzeArgs() directly.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function rec(o: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: "1.1",
    ocppVersion: "1.6",
    transport: "json",
    chargePointId: "CP001",
    ...o,
  });
}

describe("analyze subcommand (e2e spawn, #188)", () => {
  it("analyzes a trace file and writes a self-contained HTML report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-e2e-"));
    try {
      const tracePath = path.join(dir, "trace.jsonl");
      const outPath = path.join(dir, "report.html");
      const lines = [
        rec({
          timestamp: "2026-01-01T00:00:00.000Z",
          direction: "cp-to-csms",
          messageType: "CALL",
          messageId: "1",
          action: "BootNotification",
          payload: {},
        }),
        rec({
          timestamp: "2026-01-01T00:00:01.000Z",
          direction: "csms-to-cp",
          messageType: "CALLRESULT",
          messageId: "1",
          payload: {
            status: "Accepted",
            currentTime: "2026-01-01T00:00:01.000Z",
            interval: 300,
          },
        }),
      ];
      fs.writeFileSync(tracePath, lines.join("\n") + "\n");

      const proc = Bun.spawnSync(
        ["bun", "src/cli/main.ts", "analyze", tracePath, "-o", outPath],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );

      const stderr = proc.stderr.toString();
      if (proc.exitCode !== 0) {
        console.error(stderr);
      }
      expect(proc.exitCode).toBe(0);

      const html = fs.readFileSync(outPath, "utf8");
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain(
        'Failure-pattern detection is not OCPP compliance certification: "no known failure detected" does not mean "OCPP compliant".',
      );
      expect(stderr).toContain("CP001: 2 events, 0 failures");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with a usage line when no trace file is given", () => {
    const proc = Bun.spawnSync(["bun", "src/cli/main.ts", "analyze"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("Error: analyze requires a trace file path");
    expect(stderr).toContain("Usage: ocpp-cp-sim analyze");
  });
});
