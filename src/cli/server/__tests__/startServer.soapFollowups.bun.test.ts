// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { startServer, type RunningServer } from "../startServer";

/**
 * The two follow-ups of #354 (the `--soap-tunnel ngrok` PR), at the daemon
 * boundary rather than the registry's:
 *
 * 1. A SOAP charge point created under a tunnel has no persisted callback URL
 *    (deliberately — a free-tier origin changes between runs). Restarting the
 *    daemon *without* the tunnel or `--soap-public-base-url` used to throw out
 *    of the restore and exit the daemon, taking every other charge point with
 *    it. It must start, restore the rest and say what it skipped.
 * 2. `server.info` over MCP `call_method` must report the same SOAP public
 *    base as the Socket.IO method: the MCP runtime deps were built without
 *    the daemon's `ServerInfo` and answered the no-base fallback.
 */

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  pidPath: null,
  bootstrap: null,
  soapPath: "/ocpp/soap",
  autoConnect: false,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
};

async function callMcp(
  port: number,
  request: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
  }
  throw new Error(`Unexpected MCP response (${contentType}): ${text}`);
}

function toolText(response: Record<string, unknown>): string {
  const result = response.result as { content?: Array<{ text?: string }> };
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`No tool text in ${JSON.stringify(response)}`);
  }
  return text;
}

describe("startServer: #354 follow-ups", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  it("starts without a SOAP base, restores the WebSocket charge points and skips the tunnel-derived SOAP one with a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocpp-cp-sim-354-restore-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateDb = join(dir, "state.sqlite");
    {
      // The previous run had a tunnel: the SOAP row carries no callback URL.
      const db = BunSqliteDatabase.open(stateDb);
      const seed = new CPRegistry(new EventBus(), db, {
        soapPublicBaseUrl: "https://previous-run.ngrok-free.app",
        soapPath: "/ocpp/soap",
      });
      seed.create(
        {
          cpId: "CP-soap",
          wsUrl: "http://127.0.0.1:1/CentralSystemService",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          ocppVersion: "OCPP-1.6S",
        },
        { seedDefault: false },
      );
      seed.create(
        {
          cpId: "CP-ws",
          wsUrl: "ws://127.0.0.1:1/ocpp",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          ocppVersion: "OCPP-1.6J",
        },
        { seedDefault: false },
      );
      seed.shutdownAll();
      db.close();
    }

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    let running: RunningServer | null = null;
    // Before the fix this rejected with "OCPP SOAP versions require a
    // callback URL …" and main() exited 1.
    running = await startServer({ ...BASE_OPTIONS, httpPort: 0, stateDb });
    cleanups.push(() => running?.stop());
    const port = running.httpPort;
    expect(port).not.toBeNull();

    const health = (await fetch(`http://127.0.0.1:${port}/v1/healthz`).then(
      (res) => res.json(),
    )) as { ok?: boolean };
    expect(health.ok).toBe(true);

    const list = await callMcp(port!, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "call_method", arguments: { method: "cp.list" } },
    });
    const cps = JSON.parse(toolText(list)) as Array<{ cpId: string }>;
    expect(cps.map((cp) => cp.cpId)).toEqual(["CP-ws"]);

    const line = warn.mock.calls
      .map((call) => call.map(String).join(" "))
      .find((text) => text.includes('"CP-soap"'));
    expect(line).toContain("--soap-tunnel");
    expect(line).toContain("--soap-public-base-url");
  });

  it("server.info over MCP call_method reports the daemon's SOAP public base", async () => {
    let running: RunningServer | null = null;
    running = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
      stateDb: null,
      soapPublicBaseUrl: "https://public.example.test",
    });
    cleanups.push(() => running?.stop());
    const port = running.httpPort;
    expect(port).not.toBeNull();

    const response = await callMcp(port!, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "call_method", arguments: { method: "server.info" } },
    });
    const info = JSON.parse(toolText(response)) as {
      version: string;
      soap: { publicBaseUrl: string | null; path: string; tunnel: unknown };
    };
    expect(info.soap.publicBaseUrl).toBe("https://public.example.test");
    expect(info.soap.path).toBe("/ocpp/soap");
    expect(info.soap.tunnel).toBeNull();
    expect(typeof info.version).toBe("string");
  });
});
