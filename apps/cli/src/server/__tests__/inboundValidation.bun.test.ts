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
 * #593: `inboundValidation` over the control plane and `--state-db`. Absent
 * means `warn`; `cp.update` without it keeps the current value; a restored
 * charge point comes back with it, and a row written before the column
 * existed comes back as the default.
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
  ocppVersion: "OCPP-1.6J",
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("inboundValidation over the control plane (#593)", () => {
  it("cp.create sets it, status and cp.list show it, cp.update keeps or changes it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP593", ...BASE, inboundValidation: "enforce" },
      });
      expect(created.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP593")).inboundValidation,
      ).toBe("enforce");

      const status = await emitRpc(socket, {
        cpId: "CP593",
        method: "status",
        params: {},
      });
      expect(status.result.config.inboundValidation).toBe("enforce");
      const list = await emitRpc(socket, { method: "cp.list", params: {} });
      expect(list.result[0].inboundValidation).toBe("enforce");

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP593", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP593")).inboundValidation,
      ).toBe("enforce");

      const changed = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP593", ...BASE, inboundValidation: "off" },
      });
      expect(changed.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP593")).inboundValidation,
      ).toBe("off");
    } finally {
      socket.disconnect();
    }
  });

  it("cp.create without it uses warn, and an unknown value is refused", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP593-def", ...BASE },
      });
      expect(created.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP593-def")).inboundValidation,
      ).toBe("warn");

      const refused = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP593-bad", ...BASE, inboundValidation: "strict" },
      });
      expect(refused.ok).toBe(false);
      expect(server.registry.get("CP593-bad")).toBeUndefined();
    } finally {
      socket.disconnect();
    }
  });
});

describe("inboundValidation on --state-db (#593)", () => {
  it("survives a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "CP593-db",
          basicAuth: null,
          ...BASE,
          inboundValidation: "enforce",
        },
        { seedDefault: false },
      );
      expect(
        db.get<{ inbound_validation: string | null }>(
          "SELECT inbound_validation FROM charge_points WHERE cp_id = ?",
          ["CP593-db"],
        ),
      ).toEqual({ inbound_validation: "enforce" });

      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP593-db",
      ]);
      expect(restored.get("CP593-db")?.getInit().inboundValidation).toBe(
        "enforce",
      );
      expect(chargePointOf(restored.get("CP593-db")).inboundValidation).toBe(
        "enforce",
      );
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });

  it("restores a row without the column value as warn", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    try {
      db.run(
        "INSERT INTO charge_points " +
          "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
          "basic_auth, boot_notif, created_at) " +
          "VALUES (?, ?, 1, 'V', 'M', 'OCPP-1.6J', NULL, NULL, ?)",
        ["CP593-old", BASE.wsUrl, new Date().toISOString()],
      );
      expect(registry.restoreFromDatabase({ connect: false })).toEqual([
        "CP593-old",
      ]);
      expect(registry.get("CP593-old")?.getInit().inboundValidation).toBe(
        undefined,
      );
      expect(chargePointOf(registry.get("CP593-old")).inboundValidation).toBe(
        "warn",
      );
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});
