// The opt-in diagnostic support bundle (#925) through GetDiagnostics and
// GetLog, on the virtual clock, with injected uploaders standing for the CSMS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { DiagnosticsSources } from "../../cp/domain/charge-point/DiagnosticsSources";
import type { FileUploader } from "../../cp/domain/charge-point/FileUploader";
import {
  buildDiagnosticBundle,
  type DiagnosticBundle,
} from "../../cp/application/diagnostics/DiagnosticBundle";
import { readStoredZip } from "../../cp/application/diagnostics/zip";
import { LogType } from "../../cp/shared/Logger";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const SECRETS = [
  "hunter2-auth-key-0123456789",
  "s3cr3t-basic-pw",
  "tok-9f8e7d6c5b4a",
  "PRIVATEKEYBODYAAAA",
];

interface Sent {
  name: string;
  bytes: Uint8Array;
}

function capture(sent: Sent[], fail = 0): FileUploader {
  let calls = 0;
  return async (_url, file) => {
    sent.push({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    calls++;
    return calls <= fail
      ? { ok: false, status: 503 }
      : { ok: true, status: 200 };
  };
}

async function station(
  version: "1.6" | "2.0.1" | "2.1",
  uploads: { log?: FileUploader; diag?: FileUploader },
  options: { bundle?: boolean; sources?: DiagnosticsSources } = {},
): Promise<BehaviorRun> {
  return runBehavior({
    version,
    beforeConnect: (cp: ChargePoint) => {
      if (uploads.log) {
        Object.defineProperty(cp, "logUploader", { get: () => uploads.log });
      }
      if (uploads.diag) {
        Object.defineProperty(cp, "fileUploader", { get: () => uploads.diag });
      }
      cp.configuration.applyChange("RealLogUpload", "true", { operator: true });
      if (options.bundle !== false) {
        cp.configuration.applyChange("DiagnosticBundle", "true", {
          operator: true,
        });
      }
      if (options.sources) cp.setDiagnosticsSources(options.sources);
    },
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const open = (sent: Sent): Record<string, string> =>
  Object.fromEntries(
    readStoredZip(sent.bytes).map((e) => [e.name, text(e.data)]),
  );
const getLog = (requestId: number, extra: Record<string, unknown> = {}) => ({
  logType: "DiagnosticsLog",
  requestId,
  log: { remoteLocation: "https://csms.example/logs/up" },
  ...extra,
});

const twoRuns: DiagnosticsSources = {
  simulatorVersion: "9.9.9-test",
  scenarios: {
    installed: () => [
      { id: "s-a", name: "A", connectorId: 1, enabled: true },
      { id: "s-b", name: "B", connectorId: 2, enabled: true },
    ],
    activeRuns: () => [
      {
        runId: "run-b",
        scenarioId: "s-b",
        connectorId: 2,
        state: "waiting",
        stepNodeId: "n2",
      },
      {
        runId: "run-a",
        scenarioId: "s-a",
        connectorId: 1,
        state: "running",
        stepNodeId: "n1",
      },
    ],
    lastRun: () => ({
      runId: "run-old",
      scenarioId: "s-old",
      connectorId: 1,
      outcome: "passed",
    }),
    definition: (id) => ({
      id,
      nodes: [{ id: "n1", data: { password: SECRETS[1], note: "ok" } }],
    }),
  },
  traceLines: () => [
    '{"timestamp":"2000-01-01T00:00:00Z","msg":"old"}',
    '{"timestamp":"2099-01-01T00:00:00Z","msg":"new authorizationKey=' +
      SECRETS[0] +
      '"}',
  ],
};

describe.each(["1.6", "2.0.1", "2.1"] as const)(
  "GetLog support bundle (%s)",
  (version) => {
    test("uploads diagnostics.zip with every part, correlated with the requestId", async () => {
      const sent: Sent[] = [];
      run = await station(
        version,
        { log: capture(sent) },
        { sources: twoRuns },
      );
      const answer = await run.call("GetLog", getLog(5));
      expect((answer.payload as { status: string }).status).toBe("Accepted");
      expect((answer.payload as { filename: string }).filename).toMatch(
        /-DiagnosticsLog-5\.zip$/,
      );
      await run.advance(100);
      expect(sent).toHaveLength(1);
      const parts = open(sent[0]!);
      expect(Object.keys(parts).sort()).toEqual([
        "configuration.json",
        "logs.jsonl",
        "manifest.json",
        "ocpp-trace.jsonl",
        "scenario-run.json",
        "scenario.json",
        "station-state.json",
      ]);
      const manifest = JSON.parse(parts["manifest.json"]!);
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        chargePointId: run.cp.id,
        simulatorVersion: "9.9.9-test",
        transport: "websocket",
        request: { action: "GetLog", requestId: 5, logType: "DiagnosticsLog" },
      });
      expect(Object.keys(manifest.parts).sort()).toEqual(
        Object.keys(parts)
          .filter((n) => n !== "manifest.json")
          .sort(),
      );
      const notes = run
        .callsOf("LogStatusNotification")
        .map((f) => f.payload as { status: string; requestId: number });
      expect(notes).toEqual([
        { status: "Uploading", requestId: 5 },
        { status: "Uploaded", requestId: 5 },
      ]);
    });

    test("configuration separates persisted and default values and stages nothing", async () => {
      const sent: Sent[] = [];
      run = await station(version, { log: capture(sent) });
      await run.call("GetLog", getLog(6));
      await run.advance(100);
      const cfg = JSON.parse(open(sent[0]!)["configuration.json"]!);
      expect(cfg.staged).toEqual([]);
      const byName = Object.fromEntries(
        cfg.effective.map((e: { name: string }) => [e.name, e]),
      );
      expect(byName.DiagnosticBundle.value).toBe(true);
      expect(byName.HeartbeatInterval.state).toBe("default");
      // A secret key is listed (the CSMS can see it exists) with no value.
      expect(byName.AuthorizationKey.value).toBe("");
    });

    test("secrets are redacted from every part", async () => {
      const sent: Sent[] = [];
      run = await station(
        version,
        { log: capture(sent) },
        { sources: twoRuns },
      );
      run.cp.logger.enableTypes(LogType.GENERAL);
      run.cp.logger.info(
        `connecting with authorizationKey=${SECRETS[0]} and password=${SECRETS[1]}`,
      );
      run.cp.logger.info(`Authorization: Bearer ${SECRETS[2]}`);
      run.cp.logger.info(
        `ws://cp:${SECRETS[1]}@csms.example/ocpp ?token=${SECRETS[2]}`,
      );
      run.cp.configuration.applyChange("AuthorizationKey", SECRETS[0]!, {
        bypassGuard: true,
        operator: true,
      });
      await run.call("GetLog", getLog(7));
      await run.advance(100);
      const parts = open(sent[0]!);
      for (const [name, body] of Object.entries(parts)) {
        for (const secret of SECRETS) {
          expect({ name, leaked: body.includes(secret) }).toEqual({
            name,
            leaked: false,
          });
        }
      }
      // The redacted marker is there where a secret was.
      expect(parts["logs.jsonl"]).toContain("[redacted]");
      // A secret member of a scenario definition is dropped.
      expect(parts["scenario.json"]).not.toContain("password");
      expect(parts["configuration.json"]).toContain("[redacted]");
    });

    test("a failed attempt retried later sends the same snapshot (coherence)", async () => {
      const sent: Sent[] = [];
      run = await station(version, { log: capture(sent, 1) });
      await run.call("GetLog", getLog(8, { retries: 1, retryInterval: 5 }));
      await run.advance(100);
      expect(sent).toHaveLength(1);
      // The station changes while the retry waits.
      run.cp.configuration.applyChange("HeartbeatInterval", "123");
      run.cp.logger.enableTypes(LogType.GENERAL);
      run.cp.logger.info("after the snapshot");
      await run.advanceInSteps(10_000, 1000);
      expect(sent).toHaveLength(2);
      expect(
        Buffer.from(sent[1]!.bytes).equals(Buffer.from(sent[0]!.bytes)),
      ).toBe(true);
      expect(open(sent[1]!)["logs.jsonl"]).not.toContain("after the snapshot");
    });
  },
);

describe("GetDiagnostics support bundle", () => {
  test("DiagnosticBundle on: diagnostics.zip through the GetDiagnostics uploader", async () => {
    const sent: Sent[] = [];
    run = await station("1.6", { diag: capture(sent) });
    const answer = await run.call("GetDiagnostics", {
      location: "https://csms.example/diag",
    });
    expect(answer.payload).toEqual({ fileName: "diagnostics.zip" });
    await run.advance(100);
    expect(sent.map((s) => s.name)).toEqual(["diagnostics.zip"]);
    expect(open(sent[0]!)["manifest.json"]).toContain('"GetDiagnostics"');
    expect(
      run
        .callsOf("DiagnosticsStatusNotification")
        .map((f) => (f.payload as { status: string }).status),
    ).toEqual(["Uploading", "Uploaded"]);
  });

  test("DiagnosticBundle off (default): diagnostics.txt, unchanged", async () => {
    const sent: Sent[] = [];
    run = await station("1.6", { diag: capture(sent) }, { bundle: false });
    const answer = await run.call("GetDiagnostics", {
      location: "https://csms.example/diag",
    });
    expect(answer.payload).toEqual({ fileName: "diagnostics.txt" });
    await run.advance(100);
    expect(sent.map((s) => s.name)).toEqual(["diagnostics.txt"]);
  });
});

describe("bundle opt-in", () => {
  test("GetLog DiagnosticsLog without DiagnosticBundle uploads the plain log file", async () => {
    const sent: Sent[] = [];
    run = await station("2.0.1", { log: capture(sent) }, { bundle: false });
    await run.call("GetLog", getLog(9));
    await run.advance(100);
    expect(sent[0]!.name).toMatch(/\.jsonl$/);
  });

  test("a SecurityLog request never receives the bundle", async () => {
    const sent: Sent[] = [];
    run = await station("2.0.1", { log: capture(sent) });
    const answer = await run.call(
      "GetLog",
      getLog(10, { logType: "SecurityLog" }),
    );
    expect((answer.payload as { status: string }).status).toBe("Rejected");
    await run.advance(100);
    expect(sent).toEqual([]);
  });

  test("the CSMS cannot switch DiagnosticBundle on", async () => {
    run = await runBehavior({ version: "1.6" });
    const answer = await run.call("ChangeConfiguration", {
      key: "DiagnosticBundle",
      value: "true",
    });
    expect((answer.payload as { status: string }).status).toBe("Rejected");
  });

  test("DiagnosticBundle is discoverable and false by default", async () => {
    run = await runBehavior({ version: "1.6" });
    const answer = await run.call("GetConfiguration", {
      key: ["DiagnosticBundle"],
    });
    expect(answer.payload).toEqual({
      configurationKey: [
        { key: "DiagnosticBundle", readonly: true, value: "false" },
      ],
    });
  });
});

describe("bundle content", () => {
  const build = (
    r: BehaviorRun,
    window = {},
    limits?: Parameters<typeof buildDiagnosticBundle>[2],
  ): DiagnosticBundle =>
    buildDiagnosticBundle(
      r.cp,
      { action: "GetLog", requestId: 1, ...window },
      limits,
    );

  test("two concurrent runs are both listed, with no choice made between them", async () => {
    run = await runBehavior({ version: "2.0.1" });
    run.cp.setDiagnosticsSources(twoRuns);
    const b = build(run);
    const r = JSON.parse(b.parts["scenario-run.json"]!);
    expect(r.status).toBe("multiple");
    expect(r.runCount).toBe(2);
    expect(r.runs.map((x: { runId: string }) => x.runId)).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(r.lastRun.runId).toBe("run-old");
    const s = JSON.parse(b.parts["scenario.json"]!);
    expect(s.selected).toBeNull();
    expect(s.running.map((x: { scenarioId: string }) => x.scenarioId)).toEqual([
      "s-a",
      "s-b",
    ]);
  });

  test("no run in progress: explicit idle, the last run is not mixed in", async () => {
    run = await runBehavior({ version: "2.0.1" });
    run.cp.setDiagnosticsSources({
      scenarios: { ...twoRuns.scenarios!, activeRuns: () => [] },
    });
    const r = JSON.parse(build(run).parts["scenario-run.json"]!);
    expect(r.status).toBe("idle");
    expect(r.runs).toEqual([]);
    expect(r.lastRun.runId).toBe("run-old");
    const s = JSON.parse(build(run).parts["scenario.json"]!);
    expect(s.running).toEqual([]);
  });

  test("no scenario runtime and no trace source: said so, not invented", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const b = build(run);
    expect(JSON.parse(b.parts["scenario.json"]!).available).toBe(false);
    expect(JSON.parse(b.parts["scenario-run.json"]!).status).toBe(
      "unavailable",
    );
    const manifest = b.manifest as {
      parts: Record<string, { present: boolean; omitted?: string }>;
    };
    expect(manifest.parts["ocpp-trace.jsonl"]).toMatchObject({
      present: false,
    });
    expect(b.parts["ocpp-trace.jsonl"]).toBeUndefined();
  });

  test("the request window limits logs and trace; the size bound is reported", async () => {
    run = await runBehavior({ version: "2.0.1" });
    run.cp.setDiagnosticsSources(twoRuns);
    run.cp.logger.enableTypes(LogType.GENERAL);
    run.cp.logger.info("inside the window");
    const windowed = build(run, { latestTimestamp: "2001-01-01T00:00:00Z" });
    expect(windowed.parts["logs.jsonl"]).not.toContain("inside the window");
    expect(windowed.parts["ocpp-trace.jsonl"]).toContain('"old"');
    expect(windowed.parts["ocpp-trace.jsonl"]).not.toContain('"new');
    for (let i = 0; i < 20; i++) run.cp.logger.info(`filler line number ${i}`);
    const small = build(
      run,
      {},
      { logBytes: 300, traceBytes: 60, scenarioBytes: 10 },
    );
    const m = small.manifest as {
      parts: Record<string, { truncated?: number }>;
    };
    expect(m.parts["logs.jsonl"]!.truncated).toBeGreaterThan(0);
    expect(m.parts["ocpp-trace.jsonl"]!.truncated).toBeGreaterThan(0);
    expect(small.parts["logs.jsonl"]!.split("\n")[0]).toMatch(
      /^\{"truncated":\d+\}$/,
    );
    expect(
      JSON.parse(small.parts["scenario.json"]!).running[0].omitted,
    ).toContain("bound");
  });

  test("the SIM identifiers are masked and no modem internals leak", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const b = build(run);
    const state = JSON.parse(b.parts["station-state.json"]!);
    expect(state.connectivity).toHaveProperty("networkSim");
    expect(state.connectors[0].transaction).toBeNull();
    expect(JSON.stringify(state)).not.toMatch(/\d{15}/);
  });

  test("the archive is a valid ZIP: CRCs check and the unzip tool agrees", async () => {
    run = await runBehavior({ version: "2.0.1" });
    const b = build(run);
    const bytes = new Uint8Array(await b.file.arrayBuffer());
    expect(readStoredZip(bytes).length).toBeGreaterThan(5);
    const corrupt = bytes.slice();
    corrupt[60] = corrupt[60]! ^ 0xff;
    expect(() => readStoredZip(corrupt)).toThrow();
    if (spawnSync("unzip", ["-v"]).status !== null) {
      const dir = mkdtempSync(join(tmpdir(), "bundle-"));
      try {
        writeFileSync(join(dir, "b.zip"), bytes);
        const t = spawnSync("unzip", ["-t", join(dir, "b.zip")]);
        expect(t.stdout.toString()).toContain("No errors detected");
      } finally {
        rmSync(dir, { recursive: true });
      }
    }
  });
});
