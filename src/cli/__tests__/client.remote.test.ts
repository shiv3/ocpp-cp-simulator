import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteMockState = vi.hoisted(() => {
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
});

vi.mock("../../data/remote/RemoteChargePointService", () => ({
  RemoteChargePointService: remoteMockState.MockRemoteChargePointService,
}));

import { sendCommand, stopDaemon } from "../client";

describe("CLI client RemoteChargePointService adapter wiring", () => {
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    remoteMockState.instances.splice(0);
    remoteMockState.rawRpcResults.splice(0);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
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
      exitCode: undefined,
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
      exitCode: undefined,
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
  exitCode: string | number | undefined;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

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
    process.exitCode = originalExitCode;
  }
}

function callWriteCallback(args: unknown[]): void {
  for (const arg of args) {
    if (typeof arg === "function") {
      arg();
    }
  }
}
