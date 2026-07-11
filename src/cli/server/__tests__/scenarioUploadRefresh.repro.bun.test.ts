/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { connectTestClient, startTestServer } from "./socketHarness";

// Reproduction harness for #101: upload a scenario in remote mode (the daemon's
// web console), then "refresh" the page — the uploaded scenario must survive.
// This drives the exact socket RPC path the web console uses
// (scenario.definitions.replace = the editor upload persist, then
// scenario.definitions.list = the refresh re-fetch), with a file-backed daemon
// SQLite so we can also simulate a daemon restart. No browser file picker.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function emitRpc(
  socket: Socket,
  request: { method: string; params?: unknown },
): Promise<any> {
  return new Promise((resolve) => socket.emit("rpc", request, resolve));
}

function uploadedScenario(connectorId: number) {
  const now = new Date("2026-07-11T10:00:00.000Z").toISOString();
  return {
    id: "uploaded-scenario",
    name: "Uploaded Scenario",
    description: "freshly uploaded",
    targetType: "connector" as const,
    targetId: connectorId,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    enabled: true,
  };
}

async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-101-"));
  const path = join(dir, "state.db");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { path, db: BunSqliteDatabase.open(path) };
}

describe("#101 scenario upload survives refresh (remote/daemon mode)", () => {
  const cpId = "cp1";
  const connectorId = 1;

  it("re-lists the uploaded scenario after a page refresh (new socket)", async () => {
    const { db } = await tempDb();
    const server = await startTestServer({ database: db });
    cleanups.push(() => server.close());

    // Upload persist — exactly what persistEditorScenario() sends.
    const client = await connectTestClient(server);
    cleanups.push(() => client.close());
    const replaceAck = await emitRpc(client, {
      method: "scenario.definitions.replace",
      params: {
        cpId,
        connectorId,
        definitions: [uploadedScenario(connectorId)],
      },
    });
    expect(replaceAck.ok).toBe(true);

    // Refresh: a brand-new socket connection re-fetches the list.
    const afterRefresh = await connectTestClient(server);
    cleanups.push(() => afterRefresh.close());
    const listAck = await emitRpc(afterRefresh, {
      method: "scenario.definitions.list",
      params: { cpId, connectorId },
    });
    expect(listAck.ok).toBe(true);
    const names = (listAck.result as any[]).map((s) => s.name);
    expect(names).toContain("Uploaded Scenario");
  });

  it("survives a daemon restart (durable to disk)", async () => {
    const { path, db } = await tempDb();
    const server1 = await startTestServer({ database: db });
    let server1Closed = false;
    // Register cleanups immediately so a failed assertion below can't leak the
    // socket/server handles and stall later tests.
    cleanups.push(async () => {
      if (!server1Closed) await server1.close();
    });
    const client1 = await connectTestClient(server1);
    cleanups.push(() => client1.close());
    const replaceAck = await emitRpc(client1, {
      method: "scenario.definitions.replace",
      params: {
        cpId,
        connectorId,
        definitions: [uploadedScenario(connectorId)],
      },
    });
    expect(replaceAck.ok).toBe(true);
    client1.close();
    server1Closed = true;
    await server1.close();

    // Daemon restart: fresh server + DB adapter over the SAME file.
    const db2 = BunSqliteDatabase.open(path);
    const server2 = await startTestServer({ database: db2 });
    cleanups.push(() => server2.close());
    const client2 = await connectTestClient(server2);
    cleanups.push(() => client2.close());
    const listAck = await emitRpc(client2, {
      method: "scenario.definitions.list",
      params: { cpId, connectorId },
    });
    expect(listAck.ok).toBe(true);
    const names = (listAck.result as any[]).map((s) => s.name);
    expect(names).toContain("Uploaded Scenario");
  });
});
