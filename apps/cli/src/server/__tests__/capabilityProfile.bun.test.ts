/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "@ocpp-cp-sim/core/cp/domain/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-sim/core/cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #618: `capabilityProfile` over the control plane, in a blueprint and on
 * `--state-db`. `cp.update` without it keeps the profile; a row written
 * before the column existed restores with no profile.
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

const PROFILE = {
  disabledActions: ["ReserveNow"],
  triggerMessageTargets: ["Heartbeat"],
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("capabilityProfile over the control plane (#618)", () => {
  it("cp.create sets it, status shows it, cp.update keeps it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP618", ...BASE, capabilityProfile: PROFILE },
      });
      expect(created.ok).toBe(true);
      const cp = chargePointOf(server.registry.get("CP618"));
      expect(cp.isActionDisabled("ReserveNow")).toBe(true);
      expect(cp.isActionDisabled("Reset")).toBe(false);
      expect(cp.isTriggerTargetSupported("MeterValues")).toBe(false);

      const status = await emitRpc(socket, {
        cpId: "CP618",
        method: "status",
        params: {},
      });
      expect(status.result.config.capabilityProfile).toEqual(PROFILE);

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP618", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP618")).isActionDisabled(
          "ReserveNow",
        ),
      ).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it("a charge point without it disables nothing, and a malformed one is refused", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP618-none", ...BASE },
      });
      expect(created.ok).toBe(true);
      const cp = chargePointOf(server.registry.get("CP618-none"));
      expect(cp.capabilityProfile).toBeUndefined();
      expect(cp.isActionDisabled("ReserveNow")).toBe(false);
      expect(cp.isTriggerTargetSupported("MeterValues")).toBe(true);

      const refused = await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: "CP618-bad",
          ...BASE,
          capabilityProfile: { disabledActions: "ReserveNow" },
        },
      });
      expect(refused.ok).toBe(false);
    } finally {
      socket.disconnect();
    }
  });

  it("a blueprint carries it to every charge point of a fleet", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const saved = await emitRpc(socket, {
        method: "blueprint.save",
        params: {
          blueprint: {
            id: "partial",
            name: "Partial",
            params: {
              connectors: 1,
              vendor: "V",
              model: "M",
              capabilityProfile: PROFILE,
            },
          },
        },
      });
      expect(saved.ok).toBe(true);
      const ack = await emitRpc(socket, {
        method: "cp.create_many",
        params: {
          blueprintId: "partial",
          wsUrl: BASE.wsUrl,
          count: 2,
          idPattern: "P{n:02}",
        },
      });
      expect(ack.ok).toBe(true);
      for (const id of ack.result.created as string[]) {
        expect(
          chargePointOf(server.registry.get(id)).isActionDisabled("ReserveNow"),
        ).toBe(true);
      }
    } finally {
      socket.disconnect();
    }
  });
});

describe("capabilityProfile on --state-db (#618)", () => {
  it("survives a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "CP618-db",
          basicAuth: null,
          ...BASE,
          capabilityProfile: PROFILE,
        },
        { seedDefault: false },
      );
      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP618-db",
      ]);
      expect(restored.get("CP618-db")?.getInit().capabilityProfile).toEqual(
        PROFILE,
      );
      expect(
        chargePointOf(restored.get("CP618-db")).isActionDisabled("ReserveNow"),
      ).toBe(true);
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });

  it("restores a row without the column value as no profile", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    try {
      db.run(
        "INSERT INTO charge_points " +
          "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
          "basic_auth, boot_notif, created_at) " +
          "VALUES (?, ?, 1, 'V', 'M', 'OCPP-1.6J', NULL, NULL, ?)",
        ["CP618-old", BASE.wsUrl, new Date().toISOString()],
      );
      expect(registry.restoreFromDatabase({ connect: false })).toEqual([
        "CP618-old",
      ]);
      expect(registry.get("CP618-old")?.getInit().capabilityProfile).toBe(
        undefined,
      );
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});
