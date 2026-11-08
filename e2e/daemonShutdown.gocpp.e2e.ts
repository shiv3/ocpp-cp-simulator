import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCsms, stopAllCsms, type CsmsHandle } from "./support/gocppCsms";

// #622: SIGTERM on a daemon started with --shutdown-stop-transactions reaches
// the CSMS as StopTransaction before the process exits; without the flag it
// does not (the open transaction is left for the CSMS to time out).

let csms: CsmsHandle;
beforeAll(async () => {
  csms = await startCsms("OCPP-1.6J");
});
afterAll(async () => {
  await stopAllCsms();
});

const MAIN = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  void probe.stop(true);
  return port;
}

async function waitFor<T>(
  what: string,
  read: () => T | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function send(httpPort: number, cpId: string, command: object) {
  const proc = Bun.spawn(
    [
      "bun",
      MAIN,
      "--http-url",
      `http://127.0.0.1:${httpPort}`,
      "--cp-id",
      cpId,
      "--send",
      JSON.stringify(command),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(
      `send failed: ${await new Response(proc.stdout).text()} ${await new Response(proc.stderr).text()}`,
    );
}

async function runScenario(cpId: string, extraFlags: string[]) {
  const httpPort = freePort();
  const daemon = Bun.spawn(
    [
      "bun",
      MAIN,
      "--http-port",
      String(httpPort),
      "--cp-id",
      cpId,
      "--ws-url",
      csms.ocppUrl,
      "--connectors",
      "1",
      ...extraFlags,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await waitFor("BootNotification", () =>
      csms.frames
        .all()
        .find((f) => f.cpId === cpId && f.action === "BootNotification"),
    );
    await Bun.sleep(1000); // boot accepted, connector Available
    await send(httpPort, cpId, {
      command: "start_transaction",
      params: { connector: 1, tagId: "E2E-TAG" },
    });
    await waitFor("StartTransaction", () =>
      csms.frames.find(cpId, "StartTransaction"),
    );
    daemon.kill("SIGTERM");
    const code = await Promise.race([
      daemon.exited,
      Bun.sleep(20_000).then(() => "hung" as const),
    ]);
    expect(code).toBe(0);
  } finally {
    daemon.kill("SIGKILL");
  }
}

test("SIGTERM with --shutdown-stop-transactions sends StopTransaction before exit", async () => {
  const cpId = "CP-SHUT-STOP";
  await runScenario(cpId, ["--shutdown-stop-transactions"]);
  const stop = csms.frames.find(cpId, "StopTransaction");
  expect(stop).toBeDefined();
  expect(JSON.stringify(stop)).toContain("Other");
}, 60_000);

test("SIGTERM without the flag leaves the transaction open (today's behavior)", async () => {
  const cpId = "CP-SHUT-PLAIN";
  await runScenario(cpId, []);
  expect(csms.frames.find(cpId, "StopTransaction")).toBeUndefined();
}, 60_000);

test("--no-connect-restored restores the charge point from --state-db without dialling it", async () => {
  const cpId = "CP-RESTORE-OFFLINE";
  const dir = mkdtempSync(join(tmpdir(), "restore-"));
  const stateDb = join(dir, "state.db");
  const start = (extra: string[]) =>
    Bun.spawn(
      [
        "bun",
        MAIN,
        "--http-port",
        String(freePort()),
        "--state-db",
        stateDb,
        ...extra,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const boots = () =>
    csms.frames
      .all()
      .filter((f) => f.cpId === cpId && f.action === "BootNotification").length;
  try {
    // First run registers the charge point in the state DB.
    const first = start(["--cp-id", cpId, "--ws-url", csms.ocppUrl]);
    await waitFor("first boot", () => boots() >= 1);
    first.kill("SIGTERM");
    await first.exited;
    const afterFirst = boots();

    // Restored offline: nothing dials.
    const offline = start(["--no-connect-restored"]);
    await Bun.sleep(4000);
    expect(boots()).toBe(afterFirst);
    offline.kill("SIGTERM");
    await offline.exited;

    // Default: the restored charge point connects, as before.
    const online = start([]);
    await waitFor("boot after plain restore", () => boots() > afterFirst);
    online.kill("SIGTERM");
    await online.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
