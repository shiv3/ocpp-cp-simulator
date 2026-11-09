/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import {
  runMigrations,
  SCHEMA_VERSION,
} from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #595: `reservationAuthorizeIdTag` over the control plane and `--state-db`.
 * Off unless asked for; `cp.update` without it keeps the current value; a
 * restored charge point comes back with it, and a row written before the
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
  ocppVersion: "OCPP-1.6J",
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("reservationAuthorizeIdTag over the control plane (#595)", () => {
  it("cp.create sets it, status and cp.list show it, cp.update keeps or clears it", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: { cpId: "CP595", ...BASE, reservationAuthorizeIdTag: true },
      });
      expect(created.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP595")).reservationAuthorizeIdTag,
      ).toBe(true);

      const status = await emitRpc(socket, {
        cpId: "CP595",
        method: "status",
        params: {},
      });
      expect(status.result.config.reservationAuthorizeIdTag).toBe(true);
      const list = await emitRpc(socket, { method: "cp.list", params: {} });
      expect(list.result[0].reservationAuthorizeIdTag).toBe(true);

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP595", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP595")).reservationAuthorizeIdTag,
      ).toBe(true);

      const cleared = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP595", ...BASE, reservationAuthorizeIdTag: false },
      });
      expect(cleared.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP595")).reservationAuthorizeIdTag,
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
        params: { cpId: "CP595-off", ...BASE },
      });
      expect(created.ok).toBe(true);
      expect(
        chargePointOf(server.registry.get("CP595-off"))
          .reservationAuthorizeIdTag,
      ).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});

describe("reservationAuthorizeIdTag on --state-db (#595)", () => {
  it("survives a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "CP595-db",
          basicAuth: null,
          ...BASE,
          reservationAuthorizeIdTag: true,
        },
        { seedDefault: false },
      );
      expect(
        db.get<{ reservation_authorize_id_tag: number | null }>(
          "SELECT reservation_authorize_id_tag FROM charge_points WHERE cp_id = ?",
          ["CP595-db"],
        ),
      ).toEqual({ reservation_authorize_id_tag: 1 });

      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP595-db",
      ]);
      expect(
        restored.get("CP595-db")?.getInit().reservationAuthorizeIdTag,
      ).toBe(true);
      expect(
        chargePointOf(restored.get("CP595-db")).reservationAuthorizeIdTag,
      ).toBe(true);
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
          "VALUES (?, ?, 1, 'V', 'M', 'OCPP-1.6J', NULL, NULL, ?)",
        ["CP595-old", BASE.wsUrl, new Date().toISOString()],
      );
      expect(registry.restoreFromDatabase({ connect: false })).toEqual([
        "CP595-old",
      ]);
      expect(
        registry.get("CP595-old")?.getInit().reservationAuthorizeIdTag,
      ).toBe(undefined);
      expect(
        chargePointOf(registry.get("CP595-old")).reservationAuthorizeIdTag,
      ).toBe(false);
    } finally {
      registry.shutdownAll();
      db.close();
    }
  });
});

describe("schema v25 → current migration (#595, migration 0030)", () => {
  it("adds reservation_authorize_id_tag to a v25 database that has only #593's inbound_validation", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      // A database a v25 build (#593) left behind: inbound_validation, no
      // reservation_authorize_id_tag, stamped 25.
      runMigrations(db);
      db.exec(
        "ALTER TABLE charge_points DROP COLUMN reservation_authorize_id_tag",
      );
      db.run("UPDATE schema_meta SET value = '25' WHERE key = 'version'");
      db.run(
        "INSERT INTO charge_points " +
          "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
          "basic_auth, boot_notif, created_at, inbound_validation) " +
          "VALUES ('CP-V25', ?, 1, 'V', 'M', 'OCPP-1.6J', NULL, NULL, ?, 'enforce')",
        [BASE.wsUrl, new Date().toISOString()],
      );
      const names = () =>
        db
          .all<{ name: string }>("PRAGMA table_info(charge_points)")
          .map((c) => c.name);
      expect(names()).not.toContain("reservation_authorize_id_tag");

      runMigrations(db);

      expect(names()).toContain("reservation_authorize_id_tag");
      expect(names()).toContain("inbound_validation");
      expect(
        db.get<{ value: string }>(
          "SELECT value FROM schema_meta WHERE key = 'version'",
        )?.value,
      ).toBe(String(SCHEMA_VERSION));
      expect(
        db.get<{ a: number | null; v: string }>(
          "SELECT reservation_authorize_id_tag AS a, inbound_validation AS v FROM charge_points WHERE cp_id = 'CP-V25'",
        ),
      ).toEqual({ a: null, v: "enforce" });

      // The registry restores and persists it on the migrated database.
      const registry = new CPRegistry(new EventBus(), db);
      try {
        expect(registry.restoreFromDatabase({ connect: false })).toEqual([
          "CP-V25",
        ]);
        expect(registry.get("CP-V25")?.getInit().inboundValidation).toBe(
          "enforce",
        );
      } finally {
        registry.shutdownAll();
      }
    } finally {
      db.close();
    }
  });
});
