import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `fetchStoredLogs` (src/cli/client.ts) talks to a real daemon over the
// socket.io RPC transport via RemoteChargePointService; these tests exercise
// runAnalyze()'s --from-daemon branch one layer above that, the same way
// client.remote.test.ts mocks RemoteChargePointService one layer below it.
// vi.hoisted is required (not a plain outer-scope vi.fn()) because vi.mock's
// factory is hoisted above these imports, so a normal module-scope const
// would be read before its own initializer runs.
const clientMockState = vi.hoisted(() => {
  return { fetchStoredLogs: vi.fn() };
});

vi.mock("../../client", () => ({
  fetchStoredLogs: clientMockState.fetchStoredLogs,
}));

import { DEFAULT_HTTP_PORT } from "../../server/constants";
import {
  ANALYZE_DISCLAIMER,
  describeTraceSource,
  runAnalyze,
} from "../runAnalyze";

const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DEFAULT_HTTP_PORT}`;

/** Builds a `logs.get`-shaped log line carrying a raw OCPP-J wire frame, the
 *  same shape `fetchStoredLogs` returns and `logLinesToTrace` (src/trace/
 *  logEntryToTrace.ts) parses via its "Sent: "/"Received: " prefix contract. */
function wireLogLine(
  direction: "sent" | "received",
  frame: unknown,
  timestamp: string,
): { timestamp: string; message: string } {
  const prefix = direction === "sent" ? "Sent: " : "Received: ";
  return { timestamp, message: `${prefix}${JSON.stringify(frame)}` };
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

describe("describeTraceSource", () => {
  it("names the trace file for a file-sourced run", () => {
    expect(describeTraceSource({ file: "trace.jsonl" })).toBe("trace.jsonl");
  });

  it("names the daemon target and charge point for a --from-daemon run", () => {
    expect(
      describeTraceSource({
        fromDaemon: true,
        cpId: "CP001",
        httpUrl: "https://sim.example",
      }),
    ).toBe("daemon https://sim.example (cp CP001)");
  });

  it("falls back to the same default daemon URL as the other client modes (--send/--stop/--events) when --http-url is omitted", () => {
    expect(describeTraceSource({ fromDaemon: true, cpId: "CP001" })).toBe(
      `daemon ${DEFAULT_DAEMON_URL} (cp CP001)`,
    );
  });
});

describe("runAnalyze --from-daemon", () => {
  let dir: string;

  beforeEach(() => {
    clientMockState.fetchStoredLogs.mockReset();
  });

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds the trace from the daemon's stored logs and stamps the report's Source with the daemon target", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-daemon-"));
    const outPath = path.join(dir, "report.md");

    clientMockState.fetchStoredLogs.mockResolvedValue([
      wireLogLine(
        "sent",
        [2, "1", "Authorize", { idTag: "TAG1" }],
        "2026-01-01T00:00:00.000Z",
      ),
      wireLogLine(
        "received",
        [3, "1", { idTagInfo: { status: "Accepted" } }],
        "2026-01-01T00:00:01.000Z",
      ),
    ]);

    const { result: code } = await withCapturedIo(() =>
      runAnalyze({ fromDaemon: true, cpId: "CP001", output: outPath }),
    );

    expect(code).toBe(0);
    expect(clientMockState.fetchStoredLogs).toHaveBeenCalledWith(
      { httpUrl: DEFAULT_DAEMON_URL, basicAuth: null },
      "CP001",
    );
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain(
      `**Source:** daemon ${DEFAULT_DAEMON_URL} (cp CP001)`,
    );
    expect(content).toContain(ANALYZE_DISCLAIMER);
  });

  it("passes --http-url and --http-basic-auth-* through to fetchStoredLogs", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-daemon-auth-"));
    const outPath = path.join(dir, "report.md");

    clientMockState.fetchStoredLogs.mockResolvedValue([
      wireLogLine(
        "sent",
        [2, "1", "Authorize", { idTag: "TAG1" }],
        "2026-01-01T00:00:00.000Z",
      ),
      wireLogLine(
        "received",
        [3, "1", { idTagInfo: { status: "Accepted" } }],
        "2026-01-01T00:00:01.000Z",
      ),
    ]);

    await withCapturedIo(() =>
      runAnalyze({
        fromDaemon: true,
        cpId: "CP001",
        httpUrl: "https://sim.example",
        httpBasicAuth: { username: "admin", password: "secret" },
        output: outPath,
      }),
    );

    expect(clientMockState.fetchStoredLogs).toHaveBeenCalledWith(
      {
        httpUrl: "https://sim.example",
        basicAuth: { username: "admin", password: "secret" },
      },
      "CP001",
    );
  });

  // logLinesToTrace (src/trace/logEntryToTrace.ts) maps any log line that
  // isn't a "Sent: "/"Received: " OCPP-J wire frame to null and drops it --
  // scenario/diagnostic chatter is exactly that. A daemon whose stored logs
  // for this CP are all such chatter therefore yields empty trace text, and
  // must fail the same "nothing to analyze" way an all-excluded trace file
  // does, rather than e.g. crashing on an empty toolkit run.
  it("reports 'nothing to analyze' when the daemon's stored logs are all non-wire chatter", async () => {
    clientMockState.fetchStoredLogs.mockResolvedValue([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        message: "Scenario 'demo' started",
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        message: "Connector 1 -> Charging",
      },
    ]);

    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ fromDaemon: true, cpId: "CP001" }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain(
      "Error: the daemon has no stored OCPP wire logs for charge point CP001 (nothing to analyze)",
    );
  });

  it("reports a read error and exits 1 when fetchStoredLogs throws", async () => {
    clientMockState.fetchStoredLogs.mockRejectedValue(
      new Error("Cannot connect to http://127.0.0.1:9700"),
    );

    const { result: code, stderr } = await withCapturedIo(() =>
      runAnalyze({ fromDaemon: true, cpId: "CP001" }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain(
      "Error: cannot read logs from daemon: Cannot connect to http://127.0.0.1:9700",
    );
  });
});
