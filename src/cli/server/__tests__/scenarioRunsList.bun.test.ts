/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { completingScenario } from "../../__tests__/completingScenario";

/**
 * #388: `scenario.runs.list` over the wire — the daemon's finished runs across
 * charge points, filtered and paged, with `scenario_report` as the detail.
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

function createCp(server: TestServer, cpId: string): void {
  server.registry.create(
    {
      cpId,
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 2,
      vendor: "test",
      model: "test",
      basicAuth: null,
    },
    { seedDefault: false },
  );
}

/** Load `scenarioId` on `cpId`/`connector` and run it to its end. */
async function runOnce(
  socket: Socket,
  cpId: string,
  connector: number,
  scenarioId: string,
): Promise<void> {
  const scenario = completingScenario(scenarioId, { connectorId: connector });
  expect(
    (await rpc(socket, "load_scenario", { connector, scenario }, cpId)).ok,
  ).toBe(true);
  expect(
    (await rpc(socket, "run_scenario", { connector, scenarioId }, cpId)).ok,
  ).toBe(true);
  for (let i = 0; i < 50; i++) {
    const status = (
      await rpc(socket, "scenario_status", { connector, scenarioId }, cpId)
    ).result;
    if (status?.state === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // The run is recorded in the same tick it completes; give the finally a hop.
  await new Promise((r) => setTimeout(r, 20));
}

async function serverWithClient(
  database: BunSqliteDatabase | null = null,
): Promise<{ server: TestServer; socket: Socket }> {
  const server = await startTestServer({ database });
  servers.push(server);
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return { server, socket };
}

describe("#388 scenario.runs.list over RPC", () => {
  it("lists finished runs newest first, and scenario_report details one", async () => {
    const { server, socket } = await serverWithClient();
    createCp(server, "CP-A");
    await runOnce(socket, "CP-A", 1, "s1");
    await runOnce(socket, "CP-A", 1, "s1");

    const listed = await rpc(socket, "scenario.runs.list", {});
    expect(listed.ok).toBe(true);
    expect(listed.result.total).toBe(2);
    const [newest, oldest] = listed.result.runs;
    expect(newest.runId).not.toBe(oldest.runId);
    expect(newest.startedAt >= oldest.startedAt).toBe(true);
    expect(newest).toMatchObject({
      cpId: "CP-A",
      connectorId: 1,
      scenarioId: "s1",
      executionState: "completed",
      stopped: false,
    });
    expect(newest).not.toHaveProperty("transcript");

    const report = await rpc(
      socket,
      "scenario_report",
      { connector: 1, scenarioId: "s1", runId: oldest.runId },
      "CP-A",
    );
    expect(report.result.runId).toBe(oldest.runId);
    expect(Array.isArray(report.result.transcript)).toBe(true);
  }, 20_000);

  it("never returns another charge point's, connector's or scenario's runs", async () => {
    const { server, socket } = await serverWithClient();
    createCp(server, "CP-A");
    createCp(server, "CP-B");
    await runOnce(socket, "CP-A", 1, "s1");
    await runOnce(socket, "CP-A", 2, "s1");
    await runOnce(socket, "CP-A", 1, "s2");
    await runOnce(socket, "CP-B", 1, "s1");

    const filtered = (
      await rpc(socket, "scenario.runs.list", {
        cpId: "CP-A",
        connectorId: 1,
        scenarioId: "s1",
      })
    ).result;
    expect(filtered.total).toBe(1);
    expect(filtered.runs[0]).toMatchObject({
      cpId: "CP-A",
      connectorId: 1,
      scenarioId: "s1",
    });

    const cpB = (await rpc(socket, "scenario.runs.list", { cpId: "CP-B" }))
      .result;
    expect(cpB.runs.map((r: any) => r.cpId)).toEqual(["CP-B"]);
  }, 20_000);

  it("pages with limit and offset", async () => {
    const { server, socket } = await serverWithClient();
    createCp(server, "CP-A");
    for (let i = 0; i < 3; i++) await runOnce(socket, "CP-A", 1, "s1");

    const all = (await rpc(socket, "scenario.runs.list", {})).result;
    const page = (
      await rpc(socket, "scenario.runs.list", { limit: 1, offset: 1 })
    ).result;
    expect(page.total).toBe(3);
    expect(page.runs.map((r: any) => r.runId)).toEqual([all.runs[1].runId]);
  }, 20_000);

  it("finds a run by runId whatever page it is on", async () => {
    const { server, socket } = await serverWithClient();
    createCp(server, "CP-A");
    for (let i = 0; i < 3; i++) await runOnce(socket, "CP-A", 1, "s1");
    const all = (await rpc(socket, "scenario.runs.list", {})).result;
    const oldest = all.runs[2];

    const found = (
      await rpc(socket, "scenario.runs.list", { runId: oldest.runId, limit: 1 })
    ).result;
    expect(found).toEqual({ runs: [oldest], total: 1 });
  }, 20_000);

  it("rejects out-of-range paging and unknown filter values", async () => {
    const { socket } = await serverWithClient();
    for (const params of [
      { limit: 0 },
      { limit: 201 },
      { offset: -1 },
      { verdict: "MAYBE" },
      { executionState: "running" },
      { connectorId: 0 },
    ]) {
      expect(await rpc(socket, "scenario.runs.list", params)).toMatchObject({
        ok: false,
        error: { code: "invalid_params" },
      });
    }
  });

  it("drops a deleted charge point's runs", async () => {
    const { server, socket } = await serverWithClient();
    createCp(server, "CP-A");
    createCp(server, "CP-B");
    await runOnce(socket, "CP-A", 1, "s1");
    await runOnce(socket, "CP-B", 1, "s1");

    expect((await rpc(socket, "cp.delete", { cpId: "CP-A" })).ok).toBe(true);

    const left = (await rpc(socket, "scenario.runs.list", {})).result;
    expect(left.runs.map((r: any) => r.cpId)).toEqual(["CP-B"]);
  }, 20_000);

  it("keeps the history across a daemon restart on the same state DB", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const first = await serverWithClient(db);
    createCp(first.server, "CP-A");
    await runOnce(first.socket, "CP-A", 1, "s1");
    const before = (await rpc(first.socket, "scenario.runs.list", {})).result;
    // Stop the first daemon's registry without deleting its rows, as a
    // process exit would.
    first.server.registry.shutdownAll();

    const second = await serverWithClient(db);
    const after = (await rpc(second.socket, "scenario.runs.list", {})).result;
    expect(after).toEqual(before);
  }, 20_000);
});
