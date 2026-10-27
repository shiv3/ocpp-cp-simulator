/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { completingScenario } from "../../__tests__/completingScenario";

/**
 * #448: `timeline.get` over the wire — a charge point's operational
 * timeline, filtered and windowed like `logs.get`.
 */

const servers: TestServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
});

function rpc(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
  cpId?: string,
): Promise<any> {
  return socket
    .timeout(5_000)
    .emitWithAck("rpc", { ...(cpId ? { cpId } : {}), method, params });
}

async function serverWithCp(): Promise<{ socket: Socket }> {
  const server = await startTestServer({ database: null });
  servers.push(server);
  server.registry.create(
    {
      cpId: "CP-A",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 2,
      vendor: "test",
      model: "test",
      basicAuth: null,
    },
    { seedDefault: false },
  );
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return { socket };
}

async function runToEnd(socket: Socket, scenarioId: string): Promise<void> {
  const scenario = completingScenario(scenarioId, { connectorId: 2 });
  await rpc(socket, "load_scenario", { connector: 2, scenario }, "CP-A");
  await rpc(socket, "run_scenario", { connector: 2, scenarioId }, "CP-A");
  for (let i = 0; i < 50; i++) {
    const status = (
      await rpc(socket, "scenario_status", { connector: 2, scenarioId }, "CP-A")
    ).result;
    if (status?.state === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("#448 timeline.get over RPC", () => {
  it("returns the versioned timeline, filtered by kind and run", async () => {
    const { socket } = await serverWithCp();
    await runToEnd(socket, "s1");

    const all = await rpc(socket, "timeline.get", { cpId: "CP-A" });
    expect(all.ok).toBe(true);
    expect(all.result.version).toBe("1.0");
    expect(all.result.total).toBe(all.result.entries.length);
    const seqs = all.result.entries.map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));

    const started = await rpc(socket, "timeline.get", {
      cpId: "CP-A",
      kinds: ["scenario_started"],
    });
    expect(started.result.entries).toEqual([
      expect.objectContaining({
        kind: "scenario_started",
        cpId: "CP-A",
        connectorId: 2,
        data: { scenarioId: "s1" },
      }),
    ]);
    const runId = started.result.entries[0].runId;

    const run = await rpc(socket, "timeline.get", {
      cpId: "CP-A",
      runId,
      order: "desc",
      limit: 1,
    });
    expect(run.result.entries.map((e: any) => e.kind)).toEqual([
      "scenario_finished",
    ]);
    expect(run.result.total).toBe(2);
  });

  it("starts an empty timeline when cp.update rebuilds the charge point", async () => {
    const { socket } = await serverWithCp();
    await runToEnd(socket, "s1");
    const before = await rpc(socket, "timeline.get", { cpId: "CP-A" });
    expect(before.result.total).toBeGreaterThan(0);

    const updated = await rpc(socket, "cp.update", {
      cpId: "CP-A",
      wsUrl: "ws://127.0.0.1:65534/elsewhere",
    });
    expect(updated.ok).toBe(true);

    const after = await rpc(socket, "timeline.get", { cpId: "CP-A" });
    expect(after.result).toEqual({ version: "1.0", entries: [], total: 0 });
  });

  it("answers not_found for an unknown charge point", async () => {
    const { socket } = await serverWithCp();

    const reply = await rpc(socket, "timeline.get", { cpId: "nope" });

    expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses an unknown kind as invalid_params", async () => {
    const { socket } = await serverWithCp();

    const reply = await rpc(socket, "timeline.get", {
      cpId: "CP-A",
      kinds: ["alarm_acknowledged"],
    });

    expect(reply).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });
});
