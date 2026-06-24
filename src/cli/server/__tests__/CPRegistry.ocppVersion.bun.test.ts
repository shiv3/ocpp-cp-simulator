// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { describe, it, expect } from "bun:test";
import { Database as RawBunDatabase } from "bun:sqlite";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../../cp/domain/persistence/Database";
import { runMigrations } from "../../../cp/domain/persistence/schema";

class RawBunDatabaseAdapter implements Database {
  constructor(private readonly db: RawBunDatabase) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParam[] = []): void {
    this.db.prepare(sql).run(...this.coerce(params));
  }

  all<T = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    return this.db.prepare(sql).all(...this.coerce(params)) as T[];
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    return (this.db.prepare(sql).get(...this.coerce(params)) as T) ?? null;
  }

  close(): void {
    this.db.close();
  }

  private coerce(params: SqlParam[]): SqlParam[] {
    return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
  }
}

function createRegistry(database: Database): CPRegistry {
  return new CPRegistry(new EventBus(), database);
}

function startWebSocketServer(): { wsUrl: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const protocol = req.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((value) => value.trim())
        .find((value) => value.length > 0);
      if (
        server.upgrade(req, {
          headers: protocol
            ? { "sec-websocket-protocol": protocol }
            : undefined,
        })
      ) {
        return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message() {},
    },
  });
  return {
    wsUrl: server.url.toString().replace(/^http/, "ws"),
    stop: () => server.stop(true),
  };
}

async function settleWebSocketClose(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("CPRegistry ocppVersion persistence", () => {
  it("persists and restores an explicit OCPP 2.0.1 version", async () => {
    const wsServer = startWebSocketServer();
    const db = BunSqliteDatabase.open(":memory:");
    const registry = createRegistry(db);
    let restoredRegistry: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "cp-201",
          wsUrl: wsServer.wsUrl,
          connectors: 1,
          vendor: "TestVendor",
          model: "TestModel",
          basicAuth: null,
          ocppVersion: "OCPP-2.0.1",
        },
        { seedDefault: false },
      );

      const persisted = db.get<{ ocpp_version: string | null }>(
        "SELECT ocpp_version FROM charge_points WHERE cp_id = ?",
        ["cp-201"],
      );
      expect(persisted?.ocpp_version).toBe("OCPP-2.0.1");

      registry.shutdownAll();
      restoredRegistry = createRegistry(db);
      expect(restoredRegistry.restoreFromDatabase()).toEqual(["cp-201"]);
      await settleWebSocketClose();
      expect(
        restoredRegistry.get("cp-201")?.getStatus().config?.ocppVersion,
      ).toBe("OCPP-2.0.1");
    } finally {
      registry.shutdownAll();
      restoredRegistry?.shutdownAll();
      await settleWebSocketClose();
      wsServer.stop();
      await settleWebSocketClose();
      db.close();
    }
  });

  it("defaults missing ocppVersion to OCPP-1.6J in DB and restored config", async () => {
    const wsServer = startWebSocketServer();
    const db = BunSqliteDatabase.open(":memory:");
    const registry = createRegistry(db);
    let restoredRegistry: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "cp-default",
          wsUrl: wsServer.wsUrl,
          connectors: 1,
          vendor: "TestVendor",
          model: "TestModel",
          basicAuth: null,
        },
        { seedDefault: false },
      );

      const persisted = db.get<{ ocpp_version: string | null }>(
        "SELECT ocpp_version FROM charge_points WHERE cp_id = ?",
        ["cp-default"],
      );
      expect(persisted?.ocpp_version).toBe("OCPP-1.6J");

      registry.shutdownAll();
      restoredRegistry = createRegistry(db);
      expect(restoredRegistry.restoreFromDatabase()).toEqual(["cp-default"]);
      await settleWebSocketClose();
      expect(
        restoredRegistry.get("cp-default")?.getStatus().config?.ocppVersion,
      ).toBe("OCPP-1.6J");
    } finally {
      registry.shutdownAll();
      restoredRegistry?.shutdownAll();
      await settleWebSocketClose();
      wsServer.stop();
      await settleWebSocketClose();
      db.close();
    }
  });

  it("migrates a v3 charge_points table and maps legacy NULL to OCPP-1.6J", async () => {
    const wsServer = startWebSocketServer();
    const raw = new RawBunDatabase(":memory:");
    const db = new RawBunDatabaseAdapter(raw);
    let restoredRegistry: CPRegistry | null = null;
    try {
      db.exec(`
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('version', '3');

CREATE TABLE charge_points (
  cp_id          TEXT PRIMARY KEY,
  ws_url         TEXT NOT NULL,
  connectors     INTEGER NOT NULL,
  vendor         TEXT NOT NULL,
  model          TEXT NOT NULL,
  basic_auth     TEXT,
  boot_notif     TEXT,
  created_at     TEXT NOT NULL
);
INSERT INTO charge_points (
  cp_id, ws_url, connectors, vendor, model, basic_auth, boot_notif, created_at
) VALUES (
  'cp-legacy', '${wsServer.wsUrl}', 1, 'LegacyVendor', 'LegacyModel', NULL, NULL,
  '2026-06-24T00:00:00.000Z'
);
`);

      runMigrations(db);

      const columnNames = db
        .all<{ name: string }>("PRAGMA table_info(charge_points)")
        .map((column) => column.name);
      expect(columnNames).toContain("ocpp_version");

      const legacyRow = db.get<{ ocpp_version: string | null }>(
        "SELECT ocpp_version FROM charge_points WHERE cp_id = ?",
        ["cp-legacy"],
      );
      expect(legacyRow?.ocpp_version).toBeNull();

      restoredRegistry = createRegistry(db);
      expect(restoredRegistry.restoreFromDatabase()).toEqual(["cp-legacy"]);
      await settleWebSocketClose();
      expect(
        restoredRegistry.get("cp-legacy")?.getStatus().config?.ocppVersion,
      ).toBe("OCPP-1.6J");
    } finally {
      restoredRegistry?.shutdownAll();
      await settleWebSocketClose();
      wsServer.stop();
      await settleWebSocketClose();
      db.close();
    }
  });
});
