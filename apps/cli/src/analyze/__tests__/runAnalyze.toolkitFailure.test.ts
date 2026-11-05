import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// CodeRabbit finding (issue #188, Major): the per-group WRITE is isolated by
// a try/catch (runAnalyze.test.ts's "isolates a per-group write failure"
// case), but the per-group toolkit pipeline (parseOpenOcppTrace ->
// buildSessionTimeline -> detectFailures -> summarizeSessions -> report
// generation) had no equivalent guard: a throw for one charge point's data
// escaped runAnalyze() entirely instead of being isolated the same way.
//
// This mock makes parseOpenOcppTrace throw only for the group whose jsonl
// text contains "CP-BAD" (i.e. the CP-BAD group itself), delegating to the
// real implementation otherwise -- vitest's vi.mock intercepts the dynamic
// `await import("@ocpp-debugkit/toolkit/core")` in runAnalyze.ts just like a
// static import.
vi.mock("@ocpp-debugkit/toolkit/core", async () => {
  const actual = await vi.importActual<
    typeof import("@ocpp-debugkit/toolkit/core")
  >("@ocpp-debugkit/toolkit/core");
  return {
    ...actual,
    parseOpenOcppTrace: (jsonl: string) => {
      if (jsonl.includes("CP-BAD")) {
        throw new Error("simulated toolkit parse failure for CP-BAD");
      }
      return actual.parseOpenOcppTrace(jsonl);
    },
  };
});

import { ANALYZE_DISCLAIMER, runAnalyze } from "../runAnalyze";

function rec(cpId: string, o: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: "1.1",
    ocppVersion: "1.6",
    transport: "json",
    chargePointId: cpId,
    ...o,
  });
}

async function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe("runAnalyze (per-group toolkit analysis failure isolation)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isolates a per-group toolkit analysis failure: the other group still analyzes and writes, an error is printed on stderr, the successful group's summary line and the disclaimer still print, exit code 1", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-toolkitfail-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const lines = [
      rec("CP-GOOD", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-GOOD" },
      }),
      rec("CP-GOOD", {
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
      rec("CP-BAD", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-BAD" },
      }),
      rec("CP-BAD", {
        timestamp: "2026-01-01T00:00:03.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(1);

    // CP-GOOD's report was still generated and written with real content.
    const cpGoodPath = path.join(dir, "out.CP-GOOD.md");
    expect(fs.existsSync(cpGoodPath)).toBe(true);
    const cpGoodContent = fs.readFileSync(cpGoodPath, "utf8");
    expect(cpGoodContent).toContain("CP-GOOD");
    expect(cpGoodContent).toContain(ANALYZE_DISCLAIMER);

    // CP-BAD's report was never written -- its analysis failed.
    const cpBadPath = path.join(dir, "out.CP-BAD.md");
    expect(fs.existsSync(cpBadPath)).toBe(false);

    // The per-group toolkit failure is reported on stderr with the group id
    // and the underlying message, using the same convention as the
    // per-group write-failure path.
    expect(stderr).toContain(
      "Error: cannot analyze charge point CP-BAD: simulated toolkit parse failure for CP-BAD",
    );
    // CP-GOOD's summary line and the disclaimer still print even though
    // CP-BAD's analysis failed.
    expect(stderr).toContain("CP-GOOD:");
    expect(stderr).toContain(ANALYZE_DISCLAIMER);
  });
});
