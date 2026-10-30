/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #347: `txUpdatedMeterValues` over the control plane and `--state-db`.
 * Off unless asked for; `cp.update` without it keeps the current value;
 * a restored charge point comes back with it, and a row written before the
 * column existed comes back off.
 */

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

const BASE = {
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "V",
  model: "M",
  ocppVersion: "OCPP-2.0.1",
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("txUpdatedMeterValues over the control plane (#347)", () => {
  it("cp.create sets it, status and cp.list show it, cp.update keeps or clears it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP347", ...BASE, txUpdatedMeterValues: true },
      });
      expect(created.ok).toBe(true);
      expect(server.registry.get("CP347")?.getInit().txUpdatedMeterValues).toBe(
        true,
      );
      expect(
        chargePointOf(server.registry.get("CP347")).txUpdatedMeterValues,
      ).toBe(true);

      const status = await emitRpc(socket, {
        cpId: "CP347",
        method: "status",
        params: {},
      });
      expect(status.result.config.txUpdatedMeterValues).toBe(true);
      const list = await emitRpc(socket, { method: "cp.list", params: {} });
      expect(list.result[0].txUpdatedMeterValues).toBe(true);

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP347", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP347")).txUpdatedMeterValues,
      ).toBe(true);

      const cleared = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP347", ...BASE, txUpdatedMeterValues: false },
      });
      expect(cleared.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP347")).txUpdatedMeterValues,
      ).toBe(false);
    } finally {
      socket.disconnect();
    }
  });

  it("cp.create without it leaves it off", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP347-off", ...BASE },
      });
      expect(created.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP347-off")).txUpdatedMeterValues,
      ).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});

describe("txUpdatedMeterValues on --state-db (#347)", () => {
  it("survives a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "CP347-db",
          basicAuth: null,
          ...BASE,
          txUpdatedMeterValues: true,
        },
        { seedDefault: false },
      );
      expect(
        db.get<{ tx_updated_meter_values: number | null }>(
          "SELECT tx_updated_meter_values FROM charge_points WHERE cp_id = ?",
          ["CP347-db"],
        ),
      ).toEqual({ tx_updated_meter_values: 1 });

      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP347-db",
      ]);
      expect(restored.get("CP347-db")?.getInit().txUpdatedMeterValues).toBe(
        true,
      );
      expect(chargePointOf(restored.get("CP347-db")).txUpdatedMeterValues).toBe(
        true,
      );
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });

  it("restores a row without the column value as off", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    try {
      db.run(
        "INSERT INTO charge_points " +
          "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
          "basic_auth, boot_notif, created_at) " +
          "VALUES (?, ?, 1, 'V', 'M', 'OCPP-2.0.1', NULL, NULL, ?)",
        ["CP347-old", BASE.wsUrl, new Date().toISOString()],
      );
      expect(registry.restoreFromDatabase({ connect: false })).toEqual([
        "CP347-old",
      ]);
      expect(registry.get("CP347-old")?.getInit().txUpdatedMeterValues).toBe(
        undefined,
      );
      expect(
        chargePointOf(registry.get("CP347-old")).txUpdatedMeterValues,
      ).toBe(false);
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});
