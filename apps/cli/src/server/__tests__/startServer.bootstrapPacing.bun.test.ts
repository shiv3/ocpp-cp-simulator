// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { LOOPBACK, tcpPort } from "@ocpp-cp-simulator/core/test/bunServe";

import type { ChargePointInitOptions } from "../../types";
import { startServer, type RunningServer } from "../startServer";

/**
 * A charge point deleted or updated while it waits for its startup slot must
 * not be dialled with the instance captured at registration (#610).
 */

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  httpPort: 0,
  pidPath: null,
  soapPath: "/ocpp/soap",
  autoConnect: true,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
  stateDb: null,
  // Port 1 refuses at once, so a dial costs nothing and is still logged.
  bootstrap: {
    cpId: "CP",
    wsUrl: "ws://127.0.0.1:1/ocpp",
    connectors: 1,
    vendor: "V",
    model: "M",
    basicAuth: null,
  } satisfies ChargePointInitOptions,
  bootstrapCount: 2,
  // CP001 starts at once, CP002 only after 1.5 s: time to change it first.
  bootstrapPacing: {
    concurrency: 1,
    startDelayMs: 1500,
    startJitterMs: 0,
    startSeed: 0,
  },
};

async function callMethod(
  port: number,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "call_method", arguments: { method, params } },
    }),
  });
  const text = await res.text();
  expect(res.ok).toBe(true);
  expect(text).not.toContain('"isError":true');
}

describe("startServer: pacing and a charge point changed while it waits (#610)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function run(
    change: (port: number) => Promise<void>,
  ): Promise<{ log: string; done: Promise<RunningServer> }> {
    const lines: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      },
    );
    cleanups.push(() => stderr.mockRestore());
    // A port picked up front: startServer resolves only after the paced
    // loop, so it cannot report the bound one while the test must act.
    const probe = Bun.serve({
      port: 0,
      hostname: LOOPBACK,
      fetch: () => new Response(""),
    });
    const port = tcpPort(probe);
    probe.stop(true);
    const started = startServer({ ...BASE_OPTIONS, httpPort: port }).then(
      (r) => {
        cleanups.push(() => r.stop());
        return r;
      },
    );
    // Wait until CP001 has been dialled: from then on CP002 is in its delay.
    const deadline = Date.now() + 5000;
    while (
      !lines.join("").includes("Connecting CP001") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await change(port);
    const running = await started;
    return { log: lines.join(""), done: Promise.resolve(running) };
  }

  it("does not dial a charge point deleted during the delay", async () => {
    const { log } = await run((port) =>
      callMethod(port, "cp.delete", { cpId: "CP002" }),
    );
    expect(log).toContain("Connecting CP001 to CSMS");
    expect(log).toContain("Skipping startup of CP002");
    expect(log).not.toContain("Connecting CP002");
  });

  it("does not dial the discarded instance of a charge point updated during the delay", async () => {
    const { log } = await run((port) =>
      callMethod(port, "cp.update", {
        cpId: "CP002",
        wsUrl: "ws://127.0.0.1:1/ocpp",
        connectors: 1,
      }),
    );
    expect(log).toContain("Skipping startup of CP002");
    expect(log).not.toContain("Connecting CP002");
  });
});
