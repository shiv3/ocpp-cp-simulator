import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import type { EVSettings } from "../../../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../../../cp/domain/connector/MeterValueCurve";
import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../../cp/domain/persistence/Database";
import { SqliteScenarioRepository } from "../../../cp/domain/persistence/SqliteScenarioRepository";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { SimulatorConfigInput } from "../../../protocol";
import { SqliteConnectorSettingsRepository } from "../../../data/sqlite/SqliteConnectorSettingsRepository";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import type { RegistryConfigRepository } from "../RegistryChargePointService";
import { RegistryChargePointService } from "../RegistryChargePointService";

interface ScenarioRow {
  cp_id: string;
  connector_id: number;
  scenario_id: string;
  name: string;
  enabled: number;
  updated_at: string;
  definition: string;
}

interface LogRow {
  id: number;
  cp_id: string;
  timestamp: string;
  level: string;
  log_type: string;
  message: string;
}

class MemoryFacadeDatabase implements Database {
  private readonly kv = new Map<string, string>();
  private readonly scenarios = new Map<string, ScenarioRow>();
  private readonly autoMeter = new Map<string, string | null>();
  private readonly logs: LogRow[] = [];
  private nextLogId = 1;

  exec(sql: string): void {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql.trim())) return;
    throw new Error(`Unexpected exec: ${sql}`);
  }

  run(sql: string, params: SqlParam[] = []): void {
    const normalized = compactSql(sql);

    if (normalized.startsWith("INSERT INTO kv (key, value)")) {
      const [key, value] = params;
      this.kv.set(String(key), String(value));
      return;
    }

    if (normalized === "DELETE FROM kv WHERE key = ?") {
      this.kv.delete(String(params[0]));
      return;
    }

    if (normalized.startsWith("INSERT INTO scenarios ")) {
      const [
        cpId,
        connectorId,
        scenarioId,
        name,
        enabled,
        updatedAt,
        definition,
      ] = params;
      const row: ScenarioRow = {
        cp_id: String(cpId),
        connector_id: Number(connectorId),
        scenario_id: String(scenarioId),
        name: String(name),
        enabled: Number(enabled),
        updated_at: String(updatedAt),
        definition: String(definition),
      };
      this.scenarios.set(
        this.scenarioKey(row.cp_id, row.connector_id, row.scenario_id),
        row,
      );
      return;
    }

    if (
      normalized ===
      "DELETE FROM scenarios WHERE cp_id = ? AND connector_id = ? AND scenario_id = ?"
    ) {
      const [cpId, connectorId, scenarioId] = params;
      this.scenarios.delete(
        this.scenarioKey(String(cpId), Number(connectorId), String(scenarioId)),
      );
      return;
    }

    if (
      normalized ===
      "DELETE FROM scenarios WHERE cp_id = ? AND connector_id = ?"
    ) {
      const [cpId, connectorId] = params;
      for (const row of [...this.scenarios.values()]) {
        if (
          row.cp_id === String(cpId) &&
          row.connector_id === Number(connectorId)
        ) {
          this.scenarios.delete(
            this.scenarioKey(row.cp_id, row.connector_id, row.scenario_id),
          );
        }
      }
      return;
    }

    if (
      normalized.startsWith(
        "INSERT INTO connector_settings (cp_id, connector_id, auto_meter)",
      )
    ) {
      const [cpId, connectorId, value] = params;
      this.autoMeter.set(
        this.connectorKey(String(cpId), Number(connectorId)),
        value === null ? null : String(value),
      );
      return;
    }

    if (normalized === "DELETE FROM logs WHERE cp_id = ?") {
      const cpId = String(params[0]);
      for (let index = this.logs.length - 1; index >= 0; index -= 1) {
        if (this.logs[index].cp_id === cpId) this.logs.splice(index, 1);
      }
      return;
    }

    const resetTable = /^DELETE FROM ([a-z_]+)$/.exec(normalized);
    if (resetTable) {
      this.clearTable(resetTable[1]);
      return;
    }

    throw new Error(`Unexpected run: ${sql}`);
  }

  all<T = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    const normalized = compactSql(sql);

    if (
      normalized.startsWith(
        "SELECT definition FROM scenarios WHERE cp_id = ? AND connector_id = ?",
      )
    ) {
      const [cpId, connectorId] = params;
      return [...this.scenarios.values()]
        .filter(
          (row) =>
            row.cp_id === String(cpId) &&
            row.connector_id === Number(connectorId),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((row) => ({ definition: row.definition }) as T);
    }

    if (
      normalized ===
      "SELECT timestamp, level, log_type, message FROM logs WHERE cp_id = ? ORDER BY id ASC"
    ) {
      const cpId = String(params[0]);
      return this.logs
        .filter((row) => row.cp_id === cpId)
        .sort((a, b) => a.id - b.id)
        .map(
          (row) =>
            ({
              timestamp: row.timestamp,
              level: row.level,
              log_type: row.log_type,
              message: row.message,
            }) as T,
        );
    }

    throw new Error(`Unexpected all: ${sql}`);
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    const normalized = compactSql(sql);

    if (normalized === "SELECT value FROM kv WHERE key = ?") {
      const value = this.kv.get(String(params[0]));
      return value === undefined ? null : ({ value } as T);
    }

    if (
      normalized ===
      "SELECT auto_meter FROM connector_settings WHERE cp_id = ? AND connector_id = ?"
    ) {
      const [cpId, connectorId] = params;
      const value = this.autoMeter.get(
        this.connectorKey(String(cpId), Number(connectorId)),
      );
      return value === undefined ? null : ({ auto_meter: value } as T);
    }

    return this.all<T>(sql, params)[0] ?? null;
  }

  close(): void {}

  async flush(): Promise<void> {}

  addLog(cpId: string, message: string): void {
    this.logs.push({
      id: this.nextLogId,
      cp_id: cpId,
      timestamp: `2026-06-30T00:00:0${this.nextLogId}.000Z`,
      level: "INFO",
      log_type: "General",
      message,
    });
    this.nextLogId += 1;
  }

  private clearTable(table: string): void {
    switch (table) {
      case "kv":
        this.kv.clear();
        break;
      case "scenarios":
        this.scenarios.clear();
        break;
      case "connector_settings":
        this.autoMeter.clear();
        break;
      case "logs":
        this.logs.splice(0, this.logs.length);
        break;
      default:
        break;
    }
  }

  private connectorKey(cpId: string, connectorId: number): string {
    return `${cpId}\0${connectorId}`;
  }

  private scenarioKey(
    cpId: string,
    connectorId: number,
    scenarioId: string,
  ): string {
    return `${cpId}\0${connectorId}\0${scenarioId}`;
  }
}

class MemoryConfigRepository implements RegistryConfigRepository {
  private value: SimulatorConfigInput | null = null;
  private readonly listeners = new Set<
    (config: SimulatorConfigInput | null) => void
  >();

  async load(): Promise<SimulatorConfigInput | null> {
    return this.value;
  }

  async save(config: SimulatorConfigInput | null): Promise<void> {
    this.value = config;
    this.listeners.forEach((listener) => listener(config));
  }

  subscribe(
    handler: (config: SimulatorConfigInput | null) => void,
  ): () => void {
    this.listeners.add(handler);
    void this.load().then(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
}

const registries: CPRegistry[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (registries.length > 0) {
    registries.pop()?.shutdownAll();
  }
});

describe("RegistryChargePointService", () => {
  it("delegates registry lane methods and resets all state", async () => {
    const { registry, service } = createFacade();

    await service.createChargePoint({
      cpId: "cp-facade",
      wsUrl: "ws://example.test/ocpp",
      connectors: 2,
      vendor: "FacadeVendor",
      model: "FacadeModel",
    });

    expect(registry.has("cp-facade")).toBe(true);
    await expect(service.listChargePoints()).resolves.toEqual([
      expect.objectContaining({
        id: "cp-facade",
        config: expect.objectContaining({
          connectors: 2,
          vendor: "FacadeVendor",
          model: "FacadeModel",
        }),
      }),
    ]);
    await expect(service.getChargePoint("cp-facade")).resolves.toEqual(
      expect.objectContaining({ id: "cp-facade" }),
    );

    await service.resetAllState();

    expect(registry.has("cp-facade")).toBe(false);
  });

  it("delegates per-CP methods to the registry service and rejects unknown cpIds", async () => {
    const { registry, service } = createFacade();
    const perCp = registry.create(
      {
        cpId: "cp-delegate",
        wsUrl: "ws://example.test/ocpp",
        connectors: 1,
        vendor: "FacadeVendor",
        model: "FacadeModel",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const statusSpy = vi.spyOn(perCp, "updateConnectorStatus");

    await service.sendStatusNotification("cp-delegate", 1, OCPPStatus.Charging);

    expect(statusSpy).toHaveBeenCalledWith(1, OCPPStatus.Charging, undefined);
    await expect(
      service.sendStatusNotification("missing-cp", 1, OCPPStatus.Available),
    ).rejects.toThrow("cpId not found: missing-cp");
  });

  it("applyDefaultEVSettings respects an active override instead of clobbering it (#105)", async () => {
    const { registry, service } = createFacade();
    const perCp = registry.create(
      {
        cpId: "cp-ev-default",
        wsUrl: "ws://example.test/ocpp",
        connectors: 1,
        vendor: "FacadeVendor",
        model: "FacadeModel",
        basicAuth: null,
      },
      { seedDefault: false },
    );

    const overrideSettings: EVSettings = {
      modelName: "Override EV",
      batteryCapacityKwh: 50,
      maxChargingPowerKw: 40,
      initialSoc: 20,
      targetSoc: 50,
    };
    const nextDefault: EVSettings = {
      modelName: "Generic EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 150,
      initialSoc: 20,
      targetSoc: 80,
    };

    // setEVSettings is the explicit/scenario path — it must mark an
    // override that a later default propagation can't clobber.
    perCp.setEVSettings(1, overrideSettings);

    await service.applyDefaultEVSettings(nextDefault);

    expect(perCp.getEVSettings(1)).toEqual(overrideSettings);
  });

  it("delegates per-CP subscriptions and returns the unsubscribe callback", () => {
    const { registry, service } = createFacade();
    const perCp = registry.create(
      {
        cpId: "cp-subscribe",
        wsUrl: "ws://example.test/ocpp",
        connectors: 1,
        vendor: "FacadeVendor",
        model: "FacadeModel",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const unsubscribe = vi.fn();
    const onEventSpy = vi.spyOn(perCp, "onEvent").mockReturnValue(unsubscribe);
    const handler = vi.fn();

    expect(service.subscribe("cp-subscribe", handler)).toBe(unsubscribe);
    expect(onEventSpy).toHaveBeenCalledWith(expect.any(Function));
    expect(() => service.subscribe("missing-cp", handler)).toThrow(
      "cpId not found: missing-cp",
    );
  });

  it("round-trips config through the injected repository and preserves omitted or blank secrets", async () => {
    const { service } = createFacade();
    const seen: Array<unknown> = [];
    const unsubscribe = service.subscribeConfig((config) => {
      seen.push(config);
    });
    const saved = simulatorConfig();

    await service.saveConfig(saved);

    expect(await service.loadConfig()).toEqual(saved);
    expect(seen).toContainEqual(saved);

    await service.saveConfig({
      ...simulatorConfig({ ChargePointID: "cp-blank" }),
      basicAuthSettings: {
        enabled: true,
        username: "updated-user",
        password: "",
      },
    });
    await service.saveConfig({
      ...simulatorConfig({ ChargePointID: "cp-omitted" }),
      basicAuthSettings: {
        enabled: true,
        username: "updated-user",
      },
    });

    const loaded = (await service.loadConfig()) as SimulatorConfigInput | null;
    expect(loaded?.ChargePointID).toBe("cp-omitted");
    expect(loaded?.basicAuthSettings).toEqual({
      enabled: true,
      username: "updated-user",
      password: "config-secret",
    });

    unsubscribe();
  });

  it("persists scenario definitions with save then list", async () => {
    const { service } = createFacade();
    const definition = scenarioDefinition("scenario-1", 1);

    await expect(
      service.saveScenarioDefinition("cp-scenario", 1, definition),
    ).resolves.toEqual(definition);

    await expect(
      service.listScenarioDefinitions("cp-scenario", 1),
    ).resolves.toEqual([definition]);
  });

  it("returns built-in scenario templates without requiring a CP", async () => {
    const { registry, service } = createFacade();

    await expect(service.getScenarioTemplates()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "essential-cp-behavior" }),
      ]),
    );
    expect(registry.list()).toHaveLength(0);
  });

  it("implements every former A1.3c global-lane method without TODO stubs", async () => {
    const source = readFileSync(
      new URL("../RegistryChargePointService.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain(["TODO lane", "A1.3c"].join(" "));

    const { db, service } = createFacade();
    const autoMeter = autoMeterConfig();
    const definition = scenarioDefinition("scenario-global", 1);

    const unsubscribeConfig = service.subscribeConfig(() => undefined);
    unsubscribeConfig();

    await service.saveConfig(simulatorConfig());
    expect(await service.loadConfig()).toEqual(simulatorConfig());

    await service.saveAutoMeterConfig("cp-global", 1, autoMeter);
    await expect(service.getAutoMeterConfig("cp-global", 1)).resolves.toEqual(
      autoMeter,
    );

    await service.saveSocMeterSync("cp-global", 1, false);
    await expect(service.getSocMeterSync("cp-global", 1)).resolves.toBe(false);

    const unsubscribeScenarios = service.subscribeScenarioDefinitions(
      "cp-global",
      1,
      () => undefined,
    );
    unsubscribeScenarios();

    await expect(
      service.saveScenarioDefinition("cp-global", 1, definition),
    ).resolves.toEqual(definition);
    await expect(
      service.listScenarioDefinitions("cp-global", 1),
    ).resolves.toEqual([definition]);
    await expect(
      service.replaceConnectorScenarioDefinitions("cp-global", 1, [definition]),
    ).resolves.toEqual([definition]);
    await expect(
      service.deleteScenarioDefinition("cp-global", 1, definition.id),
    ).resolves.toBeUndefined();

    db.addLog("cp-global", 'password="secret-value"');
    await expect(service.listStoredLogs("cp-global")).resolves.toEqual([
      expect.objectContaining({
        cpId: "cp-global",
        message: 'password="[redacted]"',
      }),
    ]);
    await expect(service.clearStoredLogs("cp-global")).resolves.toBeUndefined();
    await expect(service.listStoredLogs("cp-global")).resolves.toEqual([]);

    await expect(service.getScenarioTemplates()).resolves.not.toHaveLength(0);
    await expect(service.resetAllState()).resolves.toBeUndefined();
  });
});

function createFacade(): {
  db: MemoryFacadeDatabase;
  registry: CPRegistry;
  service: RegistryChargePointService;
} {
  const db = new MemoryFacadeDatabase();
  const registry = new CPRegistry(new EventBus(), null);
  registries.push(registry);
  const service = new RegistryChargePointService(registry, {
    database: db,
    configRepository: new MemoryConfigRepository(),
    scenarioRepository: new SqliteScenarioRepository(db),
    connectorSettingsRepository: new SqliteConnectorSettingsRepository(db),
  });
  return { db, registry, service };
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function simulatorConfig(
  overrides: Partial<SimulatorConfigInput> = {},
): SimulatorConfigInput {
  return {
    wsURL: "ws://example.test/ocpp",
    ChargePointID: "cp-config",
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username: "config-user",
      password: "config-secret",
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "cp-config", ConnectorNumber: 1 }],
      TagIDs: ["TAG-1"],
    },
    BootNotification: {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
      firmwareVersion: "1.0",
    },
    ...overrides,
  };
}

function scenarioDefinition(
  id: string,
  connectorId: number,
): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    targetType: "connector",
    targetId: connectorId,
    nodes: [],
    edges: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:01.000Z",
    enabled: true,
  };
}

function autoMeterConfig(): AutoMeterValueConfig {
  return {
    enabled: true,
    curvePoints: [
      { time: 0, value: 0 },
      { time: 600, value: 12 },
    ],
    intervalSeconds: 15,
    autoCalculateInterval: false,
    stopAtTargetSoc: true,
  };
}
