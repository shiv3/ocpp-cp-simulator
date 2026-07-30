/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * GHCR release 0.7.5 reported `"0.0.0"` for both `scenario_report`'s
 * `simulatorVersion` and MCP `serverInfo.version`, and `/v1/healthz` carried no
 * version at all — so there was no way to confirm which build a deployed
 * simulator was actually running.
 *
 * APP_VERSION is set here to prove the value is threaded through rather than
 * still hard-coded; in a real release it comes from the package.json the
 * release workflow stamps.
 */
const STAMP = "9.9.9-test";

const servers: TestServer[] = [];
const originalAppVersion = process.env.APP_VERSION;

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  if (originalAppVersion === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = originalAppVersion;
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

const scenario = {
  id: "version-scenario",
  name: "Version scenario",
  targetType: "connector",
  targetId: 1,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    { id: "s", type: "start", position: { x: 0, y: 0 }, data: { label: "S" } },
    { id: "e", type: "end", position: { x: 0, y: 1 }, data: { label: "E" } },
  ],
  edges: [{ id: "e1", source: "s", target: "e" }],
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
};

describe("the running version is reported, not a 0.0.0 placeholder", () => {
  it("stamps /v1/healthz without disturbing the ok field probes assert on", async () => {
    process.env.APP_VERSION = STAMP;
    const server = await startTestServer();
    servers.push(server);

    const res = await fetch(`${server.url}/v1/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(STAMP);
  });

  it("stamps scenario_report.simulatorVersion", async () => {
    process.env.APP_VERSION = STAMP;
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    const cpId = "CPVERSION";

    try {
      server.registry.create(
        {
          cpId,
          wsUrl: "ws://127.0.0.1:65534/never",
          connectors: 1,
          vendor: "test",
          model: "test",
          basicAuth: null,
        },
        { seedDefault: false },
      );

      await emitRpc(socket, {
        cpId,
        method: "load_scenario",
        params: { connector: 1, scenario },
      });
      await emitRpc(socket, {
        cpId,
        method: "run_scenario",
        params: { connector: 1, scenarioId: scenario.id },
      });

      let report: { simulatorVersion?: string } | null = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        report = (
          await emitRpc(socket, {
            cpId,
            method: "scenario_report",
            params: { connector: 1, scenarioId: scenario.id },
          })
        ).result;
        if (report) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(report).not.toBeNull();
      expect(report!.simulatorVersion).toBe(STAMP);
    } finally {
      socket.disconnect();
    }
  }, 20_000);

  it("reports a dev marker rather than a bare 0.0.0 when unstamped", async () => {
    delete process.env.APP_VERSION;
    const server = await startTestServer();
    servers.push(server);

    const body = (await (await fetch(`${server.url}/v1/healthz`)).json()) as {
      version: string;
    };
    // A checkout's package.json is the 0.0.0 placeholder; either way the
    // endpoint must never claim to be release 0.0.0.
    expect(body.version).not.toBe("0.0.0");
    expect(body.version).toBe("0.0.0-dev");
  });
});
