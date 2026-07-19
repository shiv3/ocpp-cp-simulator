import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ANALYZE_DISCLAIMER, runAnalyze } from "../runAnalyze";

// Real @ocpp-debugkit/toolkit@0.4.0 — deliberately not mocked. These tests
// pin the pre-splitting guarantee (3a) against the toolkit's actual,
// verified behavior: it has no concept of chargePointId, so without
// splitTrace first, two charge points reusing a messageId can have their
// CALLs/CALLRESULTs cross-correlate and hide a real per-CP failure.

function rec(cpId: string, o: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: "1.1",
    ocppVersion: "1.6",
    transport: "json",
    chargePointId: cpId,
    ...o,
  });
}

/** Computes the verbatim OCPP-J frame text for a CALL/CALLRESULT record's
 *  own decomposed fields. Used only to build a realistic `raw` field below
 *  (Fix 5, issue #188 review) -- not a general-purpose helper for other
 *  fixtures in this file. */
function ocppJFrame(o: {
  messageType: string;
  messageId?: string;
  action?: string;
  payload?: unknown;
}): string {
  switch (o.messageType) {
    case "CALL":
      return JSON.stringify([2, o.messageId, o.action, o.payload]);
    case "CALLRESULT":
      return JSON.stringify([3, o.messageId, o.payload]);
    default:
      throw new Error(`ocppJFrame: unsupported messageType ${o.messageType}`);
  }
}

/** Same as `rec`, but also attaches a `raw` field holding the verbatim
 *  OCPP-J frame matching the record's own decomposed fields -- real
 *  `--trace-output` files always carry `raw`, and a fixture without it
 *  under-tests the no-re-stringify constraint (Fix 5, issue #188 review).
 *  Only the clean-session fixture below uses this; other fixtures in this
 *  file are left untouched. */
function recWithRaw(
  cpId: string,
  o: {
    messageType: string;
    messageId?: string;
    action?: string;
    payload?: unknown;
    [key: string]: unknown;
  },
): string {
  return rec(cpId, { ...o, raw: ocppJFrame(o) });
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

describe("runAnalyze (integration, real @ocpp-debugkit/toolkit)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a clean 1.6 session with 0 failures and the disclaimer", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-clean-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "report.md");

    const lines = [
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "BootNotification",
        payload: { chargePointVendor: "V", chargePointModel: "M" },
      }),
      recWithRaw("CP001", {
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
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "2",
        action: "Authorize",
        payload: { idTag: "TAG1" },
      }),
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:00:03.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "2",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
      recWithRaw("CP001", {
        connectorId: 1,
        timestamp: "2026-01-01T00:00:04.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "3",
        action: "StartTransaction",
        payload: {
          connectorId: 1,
          idTag: "TAG1",
          meterStart: 0,
          timestamp: "2026-01-01T00:00:04.000Z",
        },
      }),
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:00:05.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "3",
        payload: { idTagInfo: { status: "Accepted" }, transactionId: 1001 },
      }),
      recWithRaw("CP001", {
        connectorId: 1,
        timestamp: "2026-01-01T00:00:30.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "4",
        action: "MeterValues",
        payload: {
          connectorId: 1,
          transactionId: 1001,
          meterValue: [
            {
              timestamp: "2026-01-01T00:00:30.000Z",
              sampledValue: [{ value: "1000" }],
            },
          ],
        },
      }),
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:00:31.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "4",
        payload: {},
      }),
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:01:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "5",
        action: "StopTransaction",
        payload: {
          transactionId: 1001,
          meterStop: 2000,
          timestamp: "2026-01-01T00:01:00.000Z",
          idTag: "TAG1",
          reason: "Local",
        },
      }),
      recWithRaw("CP001", {
        timestamp: "2026-01-01T00:01:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "5",
        payload: {},
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("StartTransaction");
    expect(content).toContain("No failures detected");
    expect(content).toContain(ANALYZE_DISCLAIMER);
  });

  it("detects FAILED_AUTHORIZATION from an Invalid Authorize response", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-authfail-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "report.md");

    const lines = [
      rec("CP001", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "BootNotification",
        payload: {},
      }),
      rec("CP001", {
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
      rec("CP001", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "2",
        action: "Authorize",
        payload: { idTag: "TAG1" },
      }),
      rec("CP001", {
        timestamp: "2026-01-01T00:00:03.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "2",
        payload: { idTagInfo: { status: "Invalid" } },
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("FAILED_AUTHORIZATION");
  });

  it("splits CP-A and CP-B before analysis so a shared messageId can't cross-correlate a failure away", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-multicp-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const lines = [
      // CP-A: Authorize "dup" answered normally.
      rec("CP-A", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "dup",
        action: "Authorize",
        payload: { idTag: "TAG-A" },
      }),
      rec("CP-A", {
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "dup",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
      // CP-B: same messageId "dup", but the CSMS never answers it.
      rec("CP-B", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "dup",
        action: "Authorize",
        payload: { idTag: "TAG-B" },
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);
    const cpAPath = path.join(dir, "out.CP-A.md");
    const cpBPath = path.join(dir, "out.CP-B.md");
    expect(fs.existsSync(cpAPath)).toBe(true);
    expect(fs.existsSync(cpBPath)).toBe(true);

    const cpAContent = fs.readFileSync(cpAPath, "utf8");
    const cpBContent = fs.readFileSync(cpBPath, "utf8");

    // Each report names only its own charge point.
    expect(cpAContent).toContain("CP-A");
    expect(cpAContent).not.toContain("CP-B");
    expect(cpBContent).toContain("CP-B");
    expect(cpBContent).not.toContain("CP-A");

    // The pre-splitting guarantee: CP-B's unanswered Call is UNRESPONSIVE_CSMS
    // only in CP-B's report, not masked by CP-A's response to the same
    // messageId, and not leaked into CP-A's report either.
    expect(cpBContent).toContain("UNRESPONSIVE_CSMS");
    expect(cpAContent).not.toContain("UNRESPONSIVE_CSMS");
  });

  it("excludes soap and non-1.6 records and reports the counts on stderr", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-excluded-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "report.md");

    const lines = [
      rec("CP001", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Heartbeat",
        payload: {},
      }),
      rec("CP001", {
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { currentTime: "2026-01-01T00:00:01.000Z" },
      }),
      rec("CP-SOAP", {
        transport: "soap",
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "2",
        action: "BootNotification",
        payload: {},
      }),
      rec("CP-201", {
        ocppVersion: "2.0.1",
        timestamp: "2026-01-01T00:00:03.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "3",
        action: "BootNotification",
        payload: {},
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);
    expect(stderr).toContain(
      "excluded: 1 soap record(s), 1 non-1.6 record(s), 0 unparseable line(s)",
    );
    // Only the single 1.6 CP001 record made it into the report.
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("Heartbeat");
    expect(content).not.toContain("CP-SOAP");
    expect(content).not.toContain("CP-201");
  });

  it("returns exit code 1 and an error on stderr when the trace file is missing", async () => {
    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ file: "/nonexistent/does-not-exist.jsonl" }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Error: cannot read trace file:");
  });

  it("disambiguates two cpIds that sanitize to the same filename instead of overwriting", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-collide-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    // "CP/A" and "CP_A" both sanitize to "CP_A" -- distinct chargePointIds,
    // colliding filenames.
    const lines = [
      rec("CP/A", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-SLASH" },
      }),
      rec("CP/A", {
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
      rec("CP_A", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-UNDERSCORE" },
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);

    const firstPath = path.join(dir, "out.CP_A.md");
    const secondPath = path.join(dir, "out.CP_A.2.md");
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);

    const firstContent = fs.readFileSync(firstPath, "utf8");
    const secondContent = fs.readFileSync(secondPath, "utf8");
    // Group iteration order follows first-appearance in the trace file:
    // "CP/A" (lines 1-2) claims the plain path; "CP_A" (line 3) collides
    // and lands in the disambiguated one. Each report names only its own
    // station.
    expect(firstContent).toContain("CP/A");
    expect(firstContent).not.toContain("CP_A");
    expect(secondContent).toContain("CP_A");
    expect(secondContent).not.toContain("CP/A");

    // Both success lines point at the distinct, actually-written paths.
    expect(stdout).toContain(`Wrote report: ${firstPath}`);
    expect(stdout).toContain(`Wrote report: ${secondPath}`);

    // The disambiguation itself is noted on stderr, naming the original cpId.
    expect(stderr).toContain("CP_A");
    expect(stderr).toContain(secondPath);
  });

  it("isolates a per-group write failure: other groups still write, error on stderr, disclaimer still printed, exit code 1", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-writefail-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const lines = [
      rec("CP-A", {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-A" },
      }),
      rec("CP-A", {
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
      rec("CP-B", {
        timestamp: "2026-01-01T00:00:02.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Authorize",
        payload: { idTag: "TAG-B" },
      }),
      rec("CP-B", {
        timestamp: "2026-01-01T00:00:03.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" } },
      }),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    // Pre-create a DIRECTORY at CP-B's exact target path so writeFileSync
    // throws EISDIR for that group only.
    const cpBPath = path.join(dir, "out.CP-B.md");
    fs.mkdirSync(cpBPath);

    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(1);

    const cpAPath = path.join(dir, "out.CP-A.md");
    expect(fs.existsSync(cpAPath)).toBe(true);
    expect(fs.readFileSync(cpAPath, "utf8")).toContain("CP-A");

    expect(stderr).toContain("Error: cannot write report file:");
    expect(stderr).toContain(cpBPath);
    expect(stderr).toContain(ANALYZE_DISCLAIMER);
    // Per-group summary lines still printed even though one group's write failed.
    expect(stderr).toContain("CP-A:");
    expect(stderr).toContain("CP-B:");
  });
});
