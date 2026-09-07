import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Plain module-scope state, deliberately NOT `vi.hoisted()`. `vi.hoisted` is a
// vitest-only API: bun aliases the `vitest` module to `bun:test`, whose `vi`
// exposes only fn/mock/spyOn/the *AllMocks helpers/fake timers, so any file
// under src/cli/__tests__ that reaches for `vi.hoisted` dies at module load
// under `bun test src/cli/__tests__` (#339). This directory is run by BOTH
// runners in CI, so it may only use the intersection of the two `vi` objects.
//
// `vi.hoisted` was here because vitest lifts `vi.mock(...)` above the file's
// static imports, so importing `../client` statically would run the mock
// factory — and touch `remoteMockState` — before this const initialised (TDZ).
// Importing `../client` dynamically below removes that ordering hazard in both
// runners: vitest calls the factory lazily on the first import of the mocked
// module, and bun does not hoist `vi.mock` at all, so in both cases the
// factory runs after this const exists and before `../client` is loaded.
const remoteMockState = (() => {
  const instances: unknown[] = [];
  const rawRpcResults: unknown[] = [];

  class MockRemoteChargePointService {
    readonly runRawRpc = vi.fn(async () => {
      return (
        rawRpcResults.shift() ?? {
          ok: true,
          result: { accepted: true },
        }
      );
    });

    readonly subscribeRawEvents = vi.fn(async () => undefined);
    readonly onConnectionChange = vi.fn(() => () => undefined);
    readonly dispose = vi.fn();

    constructor(
      readonly httpUrl: string,
      readonly options: unknown,
    ) {
      instances.push(this);
    }
  }

  return { instances, rawRpcResults, MockRemoteChargePointService };
})();

// Captured BEFORE the mock is installed, and only under bun: `bun test` keeps
// ONE module registry for the whole run, so the `vi.mock()` below stays in
// force for every file that runs after this one. vitest gives each file its
// own registry and hoists `vi.mock` above this line, so there is nothing to
// capture (and nothing to restore) there. The `Bun` global is the runner
// discriminator: it is undefined inside vitest's workers even when the vitest
// CLI itself was launched by `bunx`/`bun run` (vitest forks node workers).
const realRemoteChargePointService = (globalThis as { Bun?: unknown }).Bun
  ? (await import("../../data/remote/RemoteChargePointService"))
      .RemoteChargePointService
  : undefined;

vi.mock("../../data/remote/RemoteChargePointService", () => ({
  RemoteChargePointService: remoteMockState.MockRemoteChargePointService,
}));

// Undo the process-global module mock when this file is done. Without it
// client.socket.test.ts — which runs next in the same `bun test
// src/cli/__tests__` process and drives the REAL RemoteChargePointService
// against a live socket.io server — got this mock instead and asserted on a
// handshake that never happened (#339).
afterAll(async () => {
  if (!realRemoteChargePointService) return;
  const { mock } = await import("bun:test");
  mock.module("../../data/remote/RemoteChargePointService", () => ({
    RemoteChargePointService: realRemoteChargePointService,
  }));
});

const { sendCommand, stopDaemon } = await import("../client");

describe("CLI client RemoteChargePointService adapter wiring", () => {
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    remoteMockState.instances.splice(0);
    remoteMockState.rawRpcResults.splice(0);
    resetExitCode(undefined);
  });

  afterEach(() => {
    resetExitCode(previousExitCode);
  });

  it("routes --send through RemoteChargePointService raw rpc", async () => {
    const output = await captureOutput(() =>
      sendCommand(
        {
          httpUrl: "http://daemon.example.test",
          basicAuth: { username: "admin", password: "secret" },
        },
        "CP001",
        JSON.stringify({
          id: "cmd-1",
          command: "status",
          params: {},
        }),
      ),
    );

    const service = latestRemoteService();
    expect(service.httpUrl).toBe("http://daemon.example.test");
    expect(service.options).toEqual({
      basicAuth: { username: "admin", password: "secret" },
    });
    expect(service.runRawRpc).toHaveBeenCalledWith("status", {}, "CP001");
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(output).toEqual({
      stdout: '{"id":"cmd-1","ok":true,"data":{"accepted":true}}\n',
      stderr: "",
      exitCode: 0,
    });
  });

  it("routes --stop through RemoteChargePointService raw rpc", async () => {
    remoteMockState.rawRpcResults.push({ ok: true, result: { ok: true } });

    const output = await captureOutput(() =>
      stopDaemon({ httpUrl: "http://daemon.example.test" }),
    );

    const service = latestRemoteService();
    expect(service.options).toEqual({ basicAuth: null });
    expect(service.runRawRpc).toHaveBeenCalledWith("server.shutdown", {});
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(output).toEqual({
      stdout: "Server stopped.\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves --send rpc failure stdout and exit code", async () => {
    remoteMockState.rawRpcResults.push({
      ok: false,
      error: { code: "not_found", message: "not found" },
    });

    const output = await captureOutput(() =>
      sendCommand(
        { httpUrl: "http://daemon.example.test" },
        "CP001",
        JSON.stringify({ id: "missing", command: "status" }),
      ),
    );

    expect(latestRemoteService().runRawRpc).toHaveBeenCalledWith(
      "status",
      {},
      "CP001",
    );
    expect(output).toEqual({
      stdout: '{"id":"missing","ok":false,"error":"not found"}\n',
      stderr: "",
      exitCode: 1,
    });
  });

  it("preserves --send inline scenario and file-path command stdout/exit behavior", async () => {
    remoteMockState.rawRpcResults.push(
      { ok: true, result: { scenarioId: "scenario-1" } },
      { ok: true, result: { scenarioId: "scenario-1" } },
    );

    const inlineOutput = await captureOutput(() =>
      sendCommand(
        { httpUrl: "http://daemon.example.test" },
        "CP001",
        JSON.stringify({
          id: "load",
          command: "load_scenario",
          params: {
            connector: 1,
            scenario: {
              id: "scenario-1",
              name: "Scenario 1",
              nodes: [],
              edges: [],
            },
          },
        }),
      ),
    );
    const inlineService = latestRemoteService();

    const fileOutput = await captureOutput(() =>
      sendCommand(
        { httpUrl: "http://daemon.example.test" },
        "CP001",
        JSON.stringify({
          id: "load",
          command: "load_scenario",
          params: {
            connector: 1,
            file: "/tmp/scenario.json",
          },
        }),
      ),
    );
    const fileService = latestRemoteService();

    expect(fileOutput).toEqual(inlineOutput);
    expect(inlineService.runRawRpc).toHaveBeenCalledWith(
      "load_scenario",
      {
        connector: 1,
        scenario: {
          id: "scenario-1",
          name: "Scenario 1",
          nodes: [],
          edges: [],
        },
      },
      "CP001",
    );
    expect(fileService.runRawRpc).toHaveBeenCalledWith(
      "load_scenario",
      { connector: 1, file: "/tmp/scenario.json" },
      "CP001",
    );
  });
});

function latestRemoteService(): InstanceType<
  typeof remoteMockState.MockRemoteChargePointService
> {
  const service =
    remoteMockState.instances[remoteMockState.instances.length - 1];
  if (!service) throw new Error("RemoteChargePointService was not created");
  return service as InstanceType<
    typeof remoteMockState.MockRemoteChargePointService
  >;
}

async function captureOutput(run: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: string | number | null | undefined;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  resetExitCode(undefined);

  process.stdout.write = function (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    stdout +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    callWriteCallback(args);
    return true;
  } as typeof process.stdout.write;

  process.stderr.write = function (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    stderr +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    callWriteCallback(args);
    return true;
  } as typeof process.stderr.write;

  try {
    await run();
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    resetExitCode(originalExitCode);
  }
}

function callWriteCallback(args: unknown[]): void {
  for (const arg of args) {
    if (typeof arg === "function") {
      arg();
    }
  }
}

/** `process.exitCode` is process-global, and the CLI entry points under test
 *  write to it. Node clears it when assigned `undefined`; **bun ignores that
 *  assignment entirely**, so the plain `process.exitCode = undefined` restore
 *  this file used to do was a no-op under `bun test` and the `1` set by the
 *  --send failure case survived to the end of the run — `bun test
 *  src/cli/__tests__` then exited 1 with all 127 tests passing (#339).
 *  Writing an explicit `0` is the only restore both runtimes honour, which is
 *  also why the success cases assert `exitCode: 0` rather than `undefined`:
 *  "0" is the same statement in both runners and does not depend on whether
 *  an earlier test — or an earlier FILE, in a directory-wide bun run — left a
 *  code behind. */
function resetExitCode(value: string | number | null | undefined): void {
  process.exitCode = value ?? 0;
}
