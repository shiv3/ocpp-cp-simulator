import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnalyze } from "../runAnalyze";

// Real @ocpp-debugkit/toolkit@0.4.0 -- deliberately not mocked, same
// convention as runAnalyze.test.ts. These pin `--split-by connector`'s
// end-to-end behavior (splitTrace.ts's connector grouping, wired through
// runAnalyze.ts) against the real toolkit pipeline.

function rec(o: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: "1.1",
    ocppVersion: "1.6",
    transport: "json",
    chargePointId: "CP001",
    ...o,
  });
}

function session(
  connectorId: number,
  startMsgId: string,
  transactionId: number,
  stopMsgId: string,
): string[] {
  return [
    rec({
      connectorId,
      timestamp: "2026-01-01T00:00:10.000Z",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: startMsgId,
      action: "StartTransaction",
      payload: {
        connectorId,
        idTag: `TAG-${connectorId}`,
        meterStart: 0,
        timestamp: "2026-01-01T00:00:10.000Z",
      },
    }),
    rec({
      timestamp: "2026-01-01T00:00:11.000Z",
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      messageId: startMsgId,
      payload: { idTagInfo: { status: "Accepted" }, transactionId },
    }),
    rec({
      connectorId,
      timestamp: "2026-01-01T00:00:20.000Z",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: `${startMsgId}-status`,
      action: "StatusNotification",
      payload: { connectorId, status: "Charging", errorCode: "NoError" },
    }),
    rec({
      timestamp: "2026-01-01T00:01:00.000Z",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: stopMsgId,
      action: "StopTransaction",
      payload: {
        transactionId,
        meterStop: 1000,
        timestamp: "2026-01-01T00:01:00.000Z",
        idTag: `TAG-${connectorId}`,
        reason: "Local",
      },
    }),
    rec({
      timestamp: "2026-01-01T00:01:01.000Z",
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      messageId: stopMsgId,
      payload: {},
    }),
  ];
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

describe("runAnalyze --split-by connector (integration, real @ocpp-debugkit/toolkit)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to charge-point splitting when --split-by is not given: one report for the whole station", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-splitby-default-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const lines = [
      rec({
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "boot",
        action: "BootNotification",
        payload: {},
      }),
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath }),
    );

    expect(code).toBe(0);
    // Single group (the whole trace is one charge point, unsplit by
    // connector) -> the plain --output path, same as any other single-CP
    // trace (runAnalyze.ts only suffixes the filename per-group when there
    // is more than one group).
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, "out.CP001-connector1.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dir, "out.CP001-connector2.md"))).toBe(
      false,
    );
  });

  it("--split-by connector produces one report per connector, each containing the replicated station-level BootNotification, and named <cpId>-connector<N>", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-splitby-connector-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const lines = [
      rec({
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "boot",
        action: "BootNotification",
        payload: { chargePointVendor: "V", chargePointModel: "M" },
      }),
      rec({
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "boot",
        payload: {
          status: "Accepted",
          currentTime: "2026-01-01T00:00:01.000Z",
          interval: 300,
        },
      }),
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code, stdout } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath, splitBy: "connector" }),
    );

    expect(code).toBe(0);

    const conn1Path = path.join(dir, "out.CP001-connector1.md");
    const conn2Path = path.join(dir, "out.CP001-connector2.md");
    expect(fs.existsSync(conn1Path)).toBe(true);
    expect(fs.existsSync(conn2Path)).toBe(true);
    expect(stdout).toContain(`Wrote report: ${conn1Path}`);
    expect(stdout).toContain(`Wrote report: ${conn2Path}`);

    const conn1 = fs.readFileSync(conn1Path, "utf8");
    const conn2 = fs.readFileSync(conn2Path, "utf8");

    // Each connector's own session (identified by its transaction id, since
    // the markdown reporter doesn't dump full payloads) is present in its
    // own report...
    expect(conn1).toContain("1001");
    expect(conn2).toContain("2002");
    // ...and NOT in the other connector's report -- the whole point of the
    // split (mirrors STATUS_TRANSITION_VIOLATION cross-connector noise from
    // the task brief: connector 1 and connector 2's StatusNotifications no
    // longer land in the same timeline).
    expect(conn1).not.toContain("2002");
    expect(conn2).not.toContain("1001");
    expect(conn1).toContain("s1");
    expect(conn1).not.toContain("s2");
    expect(conn2).toContain("s2");
    expect(conn2).not.toContain("s1-status");

    // The station-level BootNotification is replicated into both.
    expect(conn1).toContain("BootNotification");
    expect(conn2).toContain("BootNotification");
  });

  it("--split-by connector still isolates two charge points from each other (chargePointId split still applies first)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-splitby-multicp-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const outPath = path.join(dir, "out.md");

    const cpBLine = JSON.stringify({
      schemaVersion: "1.1",
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP002",
      connectorId: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "b1",
      action: "StatusNotification",
      payload: { connectorId: 1, status: "Available", errorCode: "NoError" },
    });

    const lines = [...session(1, "s1", 1001, "e1"), cpBLine];
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ file: tracePath, output: outPath, splitBy: "connector" }),
    );

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, "out.CP001-connector1.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "out.CP002-connector1.md"))).toBe(true);
  });
});
