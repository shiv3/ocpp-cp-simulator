/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #447: `sessions.list` over the wire, and the history across a `cp.update`
 * rebuild and a `--state-db` restart. No CSMS: the 1.6 charge point queues
 * its transaction CALLs offline, and the session is recorded all the same.
 */

const servers: TestServer[] = [];
const sockets: Socket[] = [];
const dbPaths: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
  for (const path of dbPaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(path + suffix, { force: true });
    }
  }
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

const CP_INIT = {
  cpId: "CP-A",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 2,
  vendor: "test",
  model: "test",
  basicAuth: null,
};

/** Offline, the #181 authorize gate would hold a local start for its full
 *  10 s timeout; nothing here is about authorization. */
function skipAuthorizeGate(svc: CLIChargePointService): void {
  (
    svc as unknown as { _chargePoint: ChargePoint }
  )._chargePoint.configuration.applyChange(
    "AuthorizeBeforeLocalStart",
    "false",
  );
}

async function serverWithCp(): Promise<{ socket: Socket }> {
  const server = await startTestServer({ database: null });
  servers.push(server);
  skipAuthorizeGate(server.registry.create(CP_INIT, { seedDefault: false }));
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return { socket };
}

async function sessions(socket: Socket, params: Record<string, unknown> = {}) {
  const ack = await rpc(socket, "sessions.list", { cpId: "CP-A", ...params });
  expect(ack.ok).toBe(true);
  return ack.result as { sessions: any[]; total: number };
}

async function untilSessions(
  socket: Socket,
  predicate: (page: { sessions: any[]; total: number }) => boolean,
): Promise<{ sessions: any[]; total: number }> {
  for (let i = 0; i < 100; i++) {
    const page = await sessions(socket);
    if (predicate(page)) return page;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `timed out; sessions: ${JSON.stringify(await sessions(socket))}`,
  );
}

async function startSession(socket: Socket, connector: number): Promise<void> {
  const ack = await rpc(
    socket,
    "start_transaction",
    { connector, tagId: "TAG-RPC" },
    "CP-A",
  );
  expect(ack.ok).toBe(true);
}

describe("#447 sessions.list over RPC", () => {
  it("lists sessions newest first, filtered by outcome and connector", async () => {
    const { socket } = await serverWithCp();
    await startSession(socket, 1);
    await untilSessions(socket, (p) => p.total === 1);
    await rpc(socket, "set_meter_value", { connector: 1, value: 1500 }, "CP-A");
    await rpc(
      socket,
      "stop_transaction",
      { connector: 1, reason: "EmergencyStop" },
      "CP-A",
    );
    await startSession(socket, 2);

    const page = await untilSessions(
      socket,
      (p) => p.total === 2 && p.sessions[1]?.outcome === "interrupted",
    );
    expect(page.sessions.map((s) => [s.connectorId, s.outcome])).toEqual([
      [2, "active"],
      [1, "interrupted"],
    ]);
    expect(page.sessions[1]).toMatchObject({
      cpId: "CP-A",
      idTag: "TAG-RPC",
      stopReason: "EmergencyStop",
      meterStopWh: 1500,
    });

    expect(
      (await sessions(socket, { outcomes: ["active"] })).sessions.map(
        (s) => s.connectorId,
      ),
    ).toEqual([2]);
    expect((await sessions(socket, { connectorId: 1 })).total).toBe(1);
    // `limit` takes the newest sessions whatever the order, like `logs.get`.
    expect(
      (await sessions(socket, { order: "asc", limit: 1 })).sessions.map(
        (s) => s.connectorId,
      ),
    ).toEqual([2]);
    expect(
      (
        await sessions(socket, { order: "asc", limit: 1, offset: 1 })
      ).sessions.map((s) => s.connectorId),
    ).toEqual([1]);
  });

  it("is not_found for an unknown charge point", async () => {
    const { socket } = await serverWithCp();
    const ack = await rpc(socket, "sessions.list", { cpId: "CP-NOPE" });
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("not_found");
  });

  it("keeps the history across cp.update, and marks the lost session interrupted", async () => {
    const { socket } = await serverWithCp();
    await startSession(socket, 1);
    await untilSessions(socket, (p) => p.sessions[0]?.outcome === "active");

    const updated = await rpc(socket, "cp.update", {
      cpId: "CP-A",
      wsUrl: "ws://127.0.0.1:65534/elsewhere",
    });
    expect(updated.ok).toBe(true);

    const page = await sessions(socket);
    expect(page.sessions).toMatchObject([
      { connectorId: 1, outcome: "interrupted", endedAt: null },
    ]);
  });
});

describe("#447 session history with --state-db", () => {
  function tempDbPath(): string {
    const path = resolve(
      tmpdir(),
      `test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    dbPaths.push(path);
    return path;
  }

  function registryOn(path: string) {
    const database = BunSqliteDatabase.open(path);
    const registry = new CPRegistry(new EventBus(), database);
    return { database, registry };
  }

  it("survives a restart: a restored transaction keeps its session active", async () => {
    const path = tempDbPath();
    const first = registryOn(path);
    const svc = first.registry.create(CP_INIT, { seedDefault: false });
    skipAuthorizeGate(svc);
    svc.startTransaction(1, "TAG-DB");
    const deadline = Date.now() + 2_000;
    while (
      first.registry.chargingSessions.list({ cpId: "CP-A" }).total === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const [before] = first.registry.chargingSessions.list({
      cpId: "CP-A",
    }).sessions;
    expect(before).toMatchObject({ outcome: "active", idTag: "TAG-DB" });
    first.registry.shutdownAll();
    first.database.close();

    const second = registryOn(path);
    try {
      second.registry.restoreFromDatabase({ connect: false });
      expect(
        second.registry.chargingSessions.list({ cpId: "CP-A" }).sessions,
      ).toEqual([before]);

      // The restored session ends like any other.
      second.registry.get("CP-A")!.stopTransaction(1);
      expect(
        second.registry.chargingSessions.list({ cpId: "CP-A" }).sessions,
      ).toMatchObject([{ sessionId: before!.sessionId, outcome: "completed" }]);
    } finally {
      second.registry.shutdownAll();
      second.database.close();
    }
  });

  it("marks a session interrupted when its transaction did not survive", async () => {
    const path = tempDbPath();
    const first = registryOn(path);
    const svc = first.registry.create(CP_INIT, { seedDefault: false });
    skipAuthorizeGate(svc);
    svc.startTransaction(1, "TAG-DB");
    const deadline = Date.now() + 2_000;
    while (
      first.registry.chargingSessions.list({ cpId: "CP-A" }).total === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    first.registry.shutdownAll();
    // The connector runtime is gone (a crash before its snapshot, say).
    first.database.run("DELETE FROM connector_runtime");
    first.database.close();

    const second = registryOn(path);
    try {
      second.registry.restoreFromDatabase({ connect: false });
      expect(
        second.registry.chargingSessions.list({ cpId: "CP-A" }).sessions,
      ).toMatchObject([
        { outcome: "interrupted", endedAt: null, energyWh: null },
      ]);
    } finally {
      second.registry.shutdownAll();
      second.database.close();
    }
  });

  it("drops a deleted charge point's sessions", async () => {
    const path = tempDbPath();
    const { database, registry } = registryOn(path);
    try {
      const svc = registry.create(CP_INIT, { seedDefault: false });
      skipAuthorizeGate(svc);
      svc.startTransaction(1, "TAG-DB");
      svc.stopTransaction(1);
      expect(registry.chargingSessions.list({ cpId: "CP-A" }).total).toBe(1);

      registry.remove("CP-A");

      expect(registry.chargingSessions.list({ cpId: "CP-A" }).total).toBe(0);
    } finally {
      registry.shutdownAll();
      database.close();
    }
  });
});
