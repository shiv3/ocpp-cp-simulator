/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { NetworkSimManager } from "../NetworkSimManager";
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

function managerFor(registry: CPRegistry, database: Database | null) {
  // The same wiring as startServer.
  const manager = new NetworkSimManager(database, {
    listLiveWsCpIds: () => registry.liveWsCpIds(),
    applyToCp: () => {},
    triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    listCpIds: () => [...registry.list()],
    applyCellularPolicies: (cpId, policies) =>
      registry.get(cpId)?.setCellularPolicies(policies),
    getCellularLink: (cpId) => registry.get(cpId)?.modemState()?.link ?? null,
  });
  registry.setNetworkSimManager(manager);
  return manager;
}

function emitRpc(socket: Socket, request: Record<string, any>): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { id: 0, ...request }, resolve),
  );
}

const createParams = (cpId: string, modem?: object) => ({
  cpId,
  wsUrl: "ws://127.0.0.1:1/ocpp",
  connectors: 1,
  vendor: "V",
  model: "M",
  autoConnect: false,
  ...(modem ? { modem } : {}),
});

describe("network_sim.cellular RPC (#930)", () => {
  it("saves, reads and clears the policy set; rejects an invalid one", async () => {
    const server = await startTestServer();
    servers.push(server);
    managerFor(server.registry, null);
    const socket = await connectTestClient(server);
    try {
      const policies = {
        "block-acme": { match: { operator: "acme" }, service: "blocked" },
        slow: { match: { iccid: ICCID }, upstreamBytesPerSecond: 1000 },
      };
      expect(
        (
          await emitRpc(socket, {
            method: "network_sim.cellular.save",
            params: { policies },
          })
        ).ok,
      ).toBe(true);
      const got = await emitRpc(socket, {
        method: "network_sim.cellular.get",
        params: {},
      });
      expect(got.result.policies).toEqual(policies);

      const bad = await emitRpc(socket, {
        method: "network_sim.cellular.save",
        params: { policies: { p: { match: { iccid: "1", operator: "a" } } } },
      });
      expect(bad.ok).toBe(false);
      expect(bad.error.code).toBe("invalid_params");
      // The previous set is untouched by the refused one.
      expect(
        (
          await emitRpc(socket, {
            method: "network_sim.cellular.get",
            params: {},
          })
        ).result.policies,
      ).toEqual(policies);

      await emitRpc(socket, {
        method: "network_sim.cellular.save",
        params: { policies: null },
      });
      expect(
        (
          await emitRpc(socket, {
            method: "network_sim.cellular.get",
            params: {},
          })
        ).result.policies,
      ).toEqual({});
    } finally {
      socket.disconnect();
    }
  });

  it("targets stations by operator, including ones created later, and reports the effect", async () => {
    const server = await startTestServer();
    servers.push(server);
    managerFor(server.registry, null);
    const socket = await connectTestClient(server);
    try {
      const sim = (n: number) => ({
        iccid: `890000000000000000${n}`,
        operator: "acme",
      });
      for (const [id, modem] of [
        ["cp-a", { networkInterface: "cellular", sim: sim(1) }],
        ["cp-eth", { networkInterface: "ethernet", sim: sim(2) }],
        ["cp-legacy", undefined],
      ] as const) {
        expect(
          (
            await emitRpc(socket, {
              method: "cp.create",
              params: createParams(id, modem),
            })
          ).ok,
        ).toBe(true);
      }
      await emitRpc(socket, {
        method: "network_sim.cellular.save",
        params: {
          policies: {
            "block-acme": { match: { operator: "acme" }, service: "blocked" },
            cap: { match: { operator: "acme" }, downstreamBytesPerSecond: 500 },
          },
        },
      });
      // A station created after the policy is governed without any per-CP rule.
      await emitRpc(socket, {
        method: "cp.create",
        params: createParams("cp-late", {
          networkInterface: "cellular",
          sim: sim(3),
        }),
      });
      const status = (
        await emitRpc(socket, {
          method: "network_sim.cellular.status",
          params: {},
        })
      ).result;
      // cp-legacy has no modem model: not governed, not listed.
      expect(status.cps.map((c: any) => c.cpId).sort()).toEqual([
        "cp-a",
        "cp-eth",
        "cp-late",
      ]);
      expect(status.total).toBe(3);
      expect(status.unavailable).toBe(2);
      expect(status.throttled).toBe(2);
      const late = status.cps.find((c: any) => c.cpId === "cp-late").link;
      expect(late).toMatchObject({
        available: false,
        reasons: ["sim_network_blocked"],
        downstreamBytesPerSecond: 500,
        enforced: true,
      });
      expect(late.policies.map((p: any) => `${p.id}:${p.by}`)).toEqual([
        "block-acme:operator",
        "cap:operator",
      ]);
      // The unused SIM of the Ethernet station is blocked in the policy, not on its link.
      expect(
        status.cps.find((c: any) => c.cpId === "cp-eth").link.available,
      ).toBe(true);
      // The status wire of a CP carries the same link.
      const modem = (
        await emitRpc(socket, { method: "modem.get", params: { cpId: "cp-a" } })
      ).result.modem;
      expect(modem.link.available).toBe(false);
      expect(JSON.stringify(modem)).not.toContain("8900000000000000001");

      // Replacing the card moves the station to the policies of the new one.
      await emitRpc(socket, {
        method: "modem.command",
        params: {
          cpId: "cp-a",
          command: "replace_sim",
          sim: { iccid: "8900000000000000009", operator: "other" },
        },
      });
      const after = (
        await emitRpc(socket, { method: "modem.get", params: { cpId: "cp-a" } })
      ).result.modem;
      expect(after.link).toMatchObject({
        available: true,
        downstreamBytesPerSecond: null,
        policies: [],
      });
    } finally {
      socket.disconnect();
    }
  });

  it("persists the policies, and a restored charge point comes up governed by them", () => {
    const database = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), database);
      const manager = managerFor(first, database);
      first.create(
        {
          cpId: "cp-r",
          wsUrl: "ws://127.0.0.1:1/ocpp",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          modem: {
            networkInterface: "cellular",
            sim: { iccid: ICCID, operator: "acme" },
          },
        },
        { seedDefault: false },
      );
      manager.saveCellular({
        b: { match: { iccid: ICCID }, service: "blocked" },
      });
      expect(first.get("cp-r")!.modemState()?.link.available).toBe(false);
      first.shutdownAll();

      // Daemon restart: a new manager reads the document before the CP is restored.
      const second = new CPRegistry(new EventBus(), database);
      const restoredManager = managerFor(second, database);
      expect(restoredManager.getCellular()).toEqual({
        b: { match: { iccid: ICCID }, service: "blocked" },
      });
      expect(second.restoreFromDatabase()).toEqual(["cp-r"]);
      const link = second.get("cp-r")!.modemState()?.link;
      expect(link?.available).toBe(false);
      expect(link?.reasons).toEqual(["sim_network_blocked"]);
      second.shutdownAll();
    } finally {
      database.close();
    }
  });
});
