/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const ICCID = "8944501234567890123";
const IMSI = "310150123456789";

function emitRpc(socket: Socket, request: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    socket.emit("rpc", { id: 0, ...request }, resolve);
  });
}

async function serverWithModemCp(): Promise<{
  server: TestServer;
  socket: Socket;
}> {
  const server = await startTestServer();
  servers.push(server);
  const socket = await connectTestClient(server);
  const created = await emitRpc(socket, {
    method: "cp.create",
    params: {
      cpId: "cp-sim",
      wsUrl: "ws://127.0.0.1:1/ocpp",
      connectors: 1,
      vendor: "V",
      model: "M",
      autoConnect: false,
      modem: { sim: { iccid: ICCID, imsi: IMSI, operator: "acme" } },
    },
  });
  expect(created.ok).toBe(true);
  return { server, socket };
}

describe("modem RPC (#928)", () => {
  it("modem.get answers the masked state; the full identifiers never leave", async () => {
    const { socket } = await serverWithModemCp();
    try {
      const ack = await emitRpc(socket, {
        method: "modem.get",
        params: { cpId: "cp-sim" },
      });
      expect(ack.ok).toBe(true);
      expect(ack.result.modem.slot).toBe("inserted");
      expect(ack.result.modem.sim.operator).toBe("acme");
      expect(ack.result.modem.sim.iccid).toBe("***************0123");
      expect(JSON.stringify(ack)).not.toContain(ICCID);
      expect(JSON.stringify(ack)).not.toContain(IMSI);
    } finally {
      socket.disconnect();
    }
  });

  it("runs the lifecycle and answers typed errors for invalid transitions", async () => {
    const { socket } = await serverWithModemCp();
    try {
      const call = async (params: Record<string, any>) =>
        (
          await emitRpc(socket, {
            method: "modem.command",
            params: { cpId: "cp-sim", ...params },
          })
        ).result;
      expect(await call({ command: "insert_sim", sim: {} })).toEqual({
        ok: false,
        error: "slot_occupied",
      });
      const suspended = await call({ command: "suspend_subscription" });
      expect(suspended.modem.sim.subscription).toBe("suspended");
      expect(suspended.modem.sim.iccid).toBe("***************0123");
      expect(await call({ command: "suspend_subscription" })).toEqual({
        ok: false,
        error: "already_suspended",
      });
      expect((await call({ command: "remove_sim" })).modem.slot).toBe("empty");
      expect(await call({ command: "remove_sim" })).toEqual({
        ok: false,
        error: "slot_empty",
      });
      expect(
        (
          await call({
            command: "insert_sim",
            sim: { iccid: "8900000000000000009" },
          })
        ).modem.sim.subscription,
      ).toBe("active");
      const bad = await emitRpc(socket, {
        method: "modem.command",
        params: {
          cpId: "cp-sim",
          command: "insert_sim",
          sim: { iccid: "bad id" },
        },
      });
      expect(bad.ok).toBe(false);
    } finally {
      socket.disconnect();
    }
  });

  it("cp.status carries the masked modem; a station without the model has none", async () => {
    const { server, socket } = await serverWithModemCp();
    try {
      const status = server.registry.get("cp-sim")!.getStatus();
      expect(status.modem?.slot).toBe("inserted");
      await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: "cp-plain",
          wsUrl: "ws://127.0.0.1:1/ocpp",
          connectors: 1,
          vendor: "V",
          model: "M",
          autoConnect: false,
        },
      });
      expect(
        server.registry.get("cp-plain")!.getStatus().modem,
      ).toBeUndefined();
      const ack = await emitRpc(socket, {
        method: "modem.command",
        params: { cpId: "cp-plain", command: "remove_sim" },
      });
      expect(ack.result).toEqual({ ok: false, error: "no_modem_model" });
      const missing = await emitRpc(socket, {
        method: "modem.get",
        params: { cpId: "nope" },
      });
      expect(missing.result).toEqual({ ok: false, error: "cp_not_found" });
    } finally {
      socket.disconnect();
    }
  });
});

describe("modem persistence (#928)", () => {
  it("a restored charge point keeps the swapped card and suspended subscription, and delete forgets them", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const first = new CPRegistry(new EventBus(), db);
    try {
      first.create(
        {
          cpId: "cp-p",
          wsUrl: "ws://127.0.0.1:1/ocpp",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          modem: { sim: { iccid: ICCID } },
        },
        { seedDefault: false },
      );
      const svc = first.get("cp-p")!;
      svc.modemCommand({
        command: "replace_sim",
        sim: { iccid: "8900000000000000002", subscription: "suspended" },
      });
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      expect(second.restoreFromDatabase()).toEqual(["cp-p"]);
      // The restored init carries no `modem`: the persisted state alone restores it.
      const modem = second.get("cp-p")!.getStatus().modem;
      expect(modem?.sim?.subscription).toBe("suspended");
      expect(modem?.sim?.iccid).toBe("***************0002");
      expect(second.remove("cp-p")).toBe(true);
      expect(
        db.get("SELECT value FROM kv WHERE key = ?", ["modem:cp-p"]),
      ).toBeNull();
      second.shutdownAll();
    } finally {
      db.close();
    }
  });
});
