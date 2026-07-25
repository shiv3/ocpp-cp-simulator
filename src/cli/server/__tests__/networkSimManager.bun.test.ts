import { afterEach, describe, expect, it } from "bun:test";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../cp/domain/persistence/Database";
import type {
  NetworkSimLayerConfig,
  ResolvedNetworkSimConfig,
} from "../../../cp/infrastructure/transport/network-sim/config";
import { NetworkSimManager } from "../NetworkSimManager";

const databases: Database[] = [];

function createTestDb(): Database {
  const db = BunSqliteDatabase.open(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases) {
    db.close();
  }
  databases.length = 0;
});

describe("NetworkSimManager", () => {
  it("loads and persists global config to kv table", () => {
    const db = createTestDb();
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 123,
      rules: {
        latency: {
          type: "latency",
          direction: "both",
          delayMs: 100,
        },
      },
    };

    manager.saveGlobal(config);
    expect(manager.getGlobal()).toEqual(config);

    // Verify it persisted to kv
    const row = db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      ["networkSim:global"],
    );
    expect(row?.value).toBeDefined();
    if (row) {
      const persisted = JSON.parse(row.value);
      expect(persisted).toEqual(config);
    }
  });

  it("clears global config when saved as null", () => {
    const db = createTestDb();
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 123,
      rules: {},
    };
    manager.saveGlobal(config);
    expect(manager.getGlobal()).toEqual(config);

    manager.saveGlobal(null);
    expect(manager.getGlobal()).toBeNull();

    // Verify deletion from kv
    const row = db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      ["networkSim:global"],
    );
    expect(row).toBeNull();
  });

  it("validates and throws on invalid global config", () => {
    const db = createTestDb();
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const invalidConfig = {
      rules: {
        bad: { type: "unknown-type" },
      },
    } as unknown as NetworkSimLayerConfig;

    expect(() => {
      manager.saveGlobal(invalidConfig);
    }).toThrow();
  });

  it("loads and persists per-CP config to kv table", () => {
    const db = createTestDb();
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: false,
      seed: 456,
      rules: {
        disconnect: {
          type: "manual-disconnect",
          reconnectDelayMs: 5000,
        },
      },
    };

    manager.saveCp("cp-1", config);
    expect(manager.getCp("cp-1")).toEqual(config);

    // Verify it persisted to kv
    const row = db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      ["networkSim:cp:cp-1"],
    );
    expect(row?.value).toBeDefined();
    if (row) {
      const persisted = JSON.parse(row.value);
      expect(persisted).toEqual(config);
    }
  });

  it("deletes per-CP config when saved as null", () => {
    const db = createTestDb();
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 789,
      rules: {},
    };
    manager.saveCp("cp-2", config);
    expect(manager.getCp("cp-2")).toEqual(config);

    manager.saveCp("cp-2", null);
    expect(manager.getCp("cp-2")).toBeNull();

    // Verify deletion from kv
    const row = db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      ["networkSim:cp:cp-2"],
    );
    expect(row).toBeNull();
  });

  it("fans out global config to all live WS CPs", () => {
    const db = createTestDb();
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => ["cp-1", "cp-2", "cp-3"],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 100,
      rules: {},
    };

    manager.saveGlobal(config);

    expect(applied).toHaveLength(3);
    expect(applied.map((a) => a.cpId).sort()).toEqual(
      ["cp-1", "cp-2", "cp-3"].sort(),
    );
  });

  it("applies per-CP config only to live CPs", () => {
    const db = createTestDb();
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => ["cp-live"],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 200,
      rules: {},
    };

    // cp-offline is not live, so should not be applied
    manager.saveCp("cp-offline", config);
    expect(applied).toHaveLength(0);

    // cp-live is live, so should be applied
    manager.saveCp("cp-live", config);
    expect(applied).toHaveLength(1);
    expect(applied[0].cpId).toBe("cp-live");
  });

  it("logs and continues when a per-CP applyToCp throws", () => {
    const db = createTestDb();
    const applied: string[] = [];
    const errors: string[] = [];
    const oldError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      const manager = new NetworkSimManager(db, {
        listLiveWsCpIds: () => ["cp-1", "cp-2"],
        applyToCp: (cpId) => {
          applied.push(cpId);
          if (cpId === "cp-1") {
            throw new Error("simulated apply error");
          }
        },
        triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
      });

      const config: NetworkSimLayerConfig = {
        enabled: true,
        seed: 300,
        rules: {},
      };

      manager.saveGlobal(config);

      // Both CPs should be attempted despite cp-1 throwing
      expect(applied).toEqual(["cp-1", "cp-2"]);
      expect(errors.some((e) => e.includes("simulated apply error"))).toBe(
        true,
      );
    } finally {
      console.error = oldError;
    }
  });

  it("resolveFor composes global + per-CP config", () => {
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const globalConfig: NetworkSimLayerConfig = {
      enabled: true,
      seed: 1000,
      rules: {
        global_rule: {
          type: "latency",
          delayMs: 50,
        },
      },
    };
    manager.saveGlobal(globalConfig);

    const perCpConfig: NetworkSimLayerConfig = {
      enabled: false,
      seed: 2000,
      rules: {
        cp_rule: {
          type: "manual-disconnect",
          reconnectDelayMs: 1000,
        },
        global_rule: null, // Override: remove the global rule
      },
    };
    manager.saveCp("cp-test", perCpConfig);

    const resolved = manager.resolveFor("cp-test");

    // Per-CP overrides take precedence
    expect(resolved.enabled).toBe(false);
    expect(resolved.seed).toBe(2000);
    // Rules: global_rule should be removed, cp_rule should be present
    expect(resolved.rules.global_rule).toBeUndefined();
    expect(resolved.rules.cp_rule).toBeDefined();
  });

  it("supports in-memory mode when db is null", () => {
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => ["cp-1"],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 400,
      rules: {},
    };

    manager.saveGlobal(config);
    expect(manager.getGlobal()).toEqual(config);

    // Config survives for the process lifetime
    expect(manager.getGlobal()).toBe(config);

    // Application happens normally
    expect(applied).toHaveLength(1);
  });

  it("onCpCreated applies resolved config to the CP", () => {
    const applied: Array<{ cpId: string; resolved: ResolvedNetworkSimConfig }> =
      [];
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => [],
      applyToCp: (cpId, resolved) => applied.push({ cpId, resolved }),
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const globalConfig: NetworkSimLayerConfig = {
      enabled: true,
      seed: 500,
      rules: {},
    };
    manager.saveGlobal(globalConfig);
    applied.length = 0; // Clear the fan-out from saveGlobal

    manager.onCpCreated("new-cp");

    expect(applied).toHaveLength(1);
    expect(applied[0].cpId).toBe("new-cp");
  });

  it("onCpDeleted removes per-CP config from kv and memory", () => {
    const db = createTestDb();
    const manager = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 600,
      rules: {},
    };
    manager.saveCp("cp-del", config);
    expect(manager.getCp("cp-del")).toBeDefined();

    manager.onCpDeleted("cp-del");

    expect(manager.getCp("cp-del")).toBeNull();

    // Verify deletion from kv
    const row = db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      ["networkSim:cp:cp-del"],
    );
    expect(row).toBeNull();
  });

  it("handles kv corruption by logging and treating absent", () => {
    const db = createTestDb();
    const errors: string[] = [];
    const oldError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      // Insert bad JSON into kv
      db.run("INSERT INTO kv (key, value) VALUES (?, ?)", [
        "networkSim:global",
        "not valid json {",
      ]);

      const manager = new NetworkSimManager(db, {
        listLiveWsCpIds: () => [],
        applyToCp: () => {},
        triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
      });

      // Load should not crash, but should log error
      expect(manager.getGlobal()).toBeNull();
      expect(
        errors.some((e) => e.includes("Error loading global config")),
      ).toBe(true);
    } finally {
      console.error = oldError;
    }
  });

  it("loads persisted config on initialization", () => {
    const db = createTestDb();

    // Create and save a config
    const manager1 = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    const config: NetworkSimLayerConfig = {
      enabled: true,
      seed: 700,
      rules: {
        latency: {
          type: "latency",
          delayMs: 75,
        },
      },
    };
    manager1.saveGlobal(config);
    manager1.saveCp("cp-persist", config);

    // Create a new manager with same db
    const manager2 = new NetworkSimManager(db, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "not_connected" }),
    });

    // Should have loaded the persisted config
    expect(manager2.getGlobal()).toEqual(config);
    expect(manager2.getCp("cp-persist")).toEqual(config);
  });

  it("triggerDisconnect delegates to deps", () => {
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => [],
      applyToCp: () => {},
      triggerCpDisconnect: (cpId, ruleId) => {
        if (cpId === "cp-1" && ruleId === "rule-1") {
          return { ok: true };
        }
        return { ok: false, error: "unknown" };
      },
    });

    const result1 = manager.triggerDisconnect("cp-1", "rule-1");
    expect(result1).toEqual({ ok: true });

    const result2 = manager.triggerDisconnect("cp-2", "rule-2");
    expect(result2.ok).toBe(false);
  });
});
