/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #327: `chargerCapabilities` is carried through every boundary: the
 * `cp.create` parameters and a blueprint's `params`, the init options, the
 * `charge_points` row (schema v30) and the runtime `Connector`.
 */

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

const BASE = {
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 2,
  vendor: "V",
  model: "M",
  ocppVersion: "OCPP-1.6J",
};

const CAPS = {
  connectors: [
    { connectorId: 1, maxDeliveryPowerW: 22_000 },
    { connectorId: 2, maxDeliveryPowerW: 11_000 },
  ],
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("chargerCapabilities over the control plane (#327)", () => {
  it("cp.create sets the cap per connector, status shows it, cp.update keeps it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CAP1", ...BASE, chargerCapabilities: CAPS },
      });
      expect(created.ok).toBe(true);
      const cp = chargePointOf(server.registry.get("CAP1"));
      expect(cp.getConnector(1)?.maxDeliveryPowerW).toBe(22_000);
      expect(cp.getConnector(2)?.maxDeliveryPowerW).toBe(11_000);

      const status = await emitRpc(socket, {
        cpId: "CAP1",
        method: "status",
        params: {},
      });
      expect(status.result.config.chargerCapabilities).toEqual(CAPS);

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CAP1", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CAP1")).getConnector(2)
          ?.maxDeliveryPowerW,
      ).toBe(11_000);
    } finally {
      socket.disconnect();
    }
  });

  it("refuses a malformed cap rather than ignoring it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      for (const bad of [
        { connectors: [{ connectorId: 1, maxDeliveryPowerW: 0 }] },
        { connectors: [{ connectorId: 0, maxDeliveryPowerW: 1000 }] },
        {
          connectors: [
            { connectorId: 1, maxDeliveryPowerW: 1000 },
            { connectorId: 1, maxDeliveryPowerW: 2000 },
          ],
        },
        { connectors: [{ connectorId: 1, maxDeliveryPowerW: 1000, kw: 1 }] },
      ]) {
        const ack = await emitRpc(socket, {
          method: "cp.create",
          params: { cpId: "BAD", ...BASE, chargerCapabilities: bad },
        });
        expect(ack.ok).toBe(false);
        expect(ack.error.code).toBe("invalid_params");
      }
      expect(server.registry.get("BAD")).toBeUndefined();
    } finally {
      socket.disconnect();
    }
  });

  it("a built-in blueprint caps every connector of a fleet at its rating", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "cp.create_many",
        params: {
          blueprintId: "dc-50kw",
          wsUrl: BASE.wsUrl,
          count: 1,
          idPattern: "D{n:02}",
        },
      });
      expect(ack.ok).toBe(true);
      const cp = chargePointOf(server.registry.get("D01"));
      expect(cp.getConnector(1)?.maxDeliveryPowerW).toBe(50_000);
      expect(cp.getConnector(2)?.maxDeliveryPowerW).toBe(50_000);
      // The rating is the charger's, not the vehicle's: the EV keeps its own
      // default ceiling.
      expect(cp.getConnector(1)?.evSettings.maxChargingPowerKw).toBe(150);
    } finally {
      socket.disconnect();
    }
  });
});

describe("chargerCapabilities on --state-db (#327)", () => {
  it("survives a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        { cpId: "CAP-db", basicAuth: null, ...BASE, chargerCapabilities: CAPS },
        { seedDefault: false },
      );
      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CAP-db",
      ]);
      expect(restored.get("CAP-db")?.getInit().chargerCapabilities).toEqual(
        CAPS,
      );
      expect(
        chargePointOf(restored.get("CAP-db")).getConnector(1)
          ?.maxDeliveryPowerW,
      ).toBe(22_000);
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });

  it("restores a row older than the column, or with unreadable JSON, as uncapped", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    try {
      const insert = (id: string, caps: string | null) =>
        db.run(
          "INSERT INTO charge_points " +
            "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
            "basic_auth, boot_notif, created_at, charger_capabilities) " +
            "VALUES (?, ?, 1, 'V', 'M', 'OCPP-1.6J', NULL, NULL, ?, ?)",
          [id, BASE.wsUrl, new Date().toISOString(), caps],
        );
      insert("CAP-null", null);
      insert(
        "CAP-junk",
        '{"connectors":[{"connectorId":1,"maxDeliveryPowerW":-5}]}',
      );
      expect(registry.restoreFromDatabase({ connect: false }).sort()).toEqual([
        "CAP-junk",
        "CAP-null",
      ]);
      for (const id of ["CAP-null", "CAP-junk"]) {
        expect(registry.get(id)?.getInit().chargerCapabilities).toBe(undefined);
        expect(
          chargePointOf(registry.get(id)).getConnector(1)?.maxDeliveryPowerW,
        ).toBe(undefined);
      }
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});
