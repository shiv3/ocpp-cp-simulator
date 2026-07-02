import { describe, expect, it } from "vitest";

import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type {
  Database,
  SqlParam,
  SqlRow,
} from "../../cp/domain/persistence/Database";
import { LocalChargePointService } from "./LocalChargePointService";

class MemoryConnectorSettingsDatabase implements Database {
  private readonly autoMeter = new Map<string, string | null>();
  private readonly kv = new Map<string, string>();

  exec(sql: string): void {
    throw new Error(`Unexpected exec: ${sql}`);
  }

  run(sql: string, params: SqlParam[] = []): void {
    if (
      sql.startsWith(
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

    if (sql.startsWith("INSERT INTO kv (key, value)")) {
      const [key, value] = params;
      this.kv.set(String(key), String(value));
      return;
    }

    throw new Error(`Unexpected run: ${sql}`);
  }

  all<T = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    throw new Error(`Unexpected all: ${sql}`);
  }

  get<T = SqlRow>(sql: string, params: SqlParam[] = []): T | null {
    if (sql.startsWith("SELECT auto_meter FROM connector_settings")) {
      const [cpId, connectorId] = params;
      const value = this.autoMeter.get(
        this.connectorKey(String(cpId), Number(connectorId)),
      );
      return value === undefined ? null : ({ auto_meter: value } as T);
    }

    if (sql.startsWith("SELECT value FROM kv WHERE key = ?")) {
      const value = this.kv.get(String(params[0]));
      return value === undefined ? null : ({ value } as T);
    }

    throw new Error(`Unexpected get: ${sql}`);
  }

  close(): void {}

  async flush(): Promise<void> {}

  private connectorKey(cpId: string, connectorId: number): string {
    return `${cpId}\0${connectorId}`;
  }
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

describe("LocalChargePointService connector settings persistence", () => {
  it("round-trips auto-meter get/save through ConnectorSettingsRepository", async () => {
    const service = new LocalChargePointService(
      new MemoryConnectorSettingsDatabase(),
    );
    const config = autoMeterConfig();

    await expect(service.getAutoMeterConfig("cp-1", 1)).resolves.toBeNull();

    await service.saveAutoMeterConfig("cp-1", 1, config);

    await expect(service.getAutoMeterConfig("cp-1", 1)).resolves.toEqual(
      config,
    );
    await expect(service.getAutoMeterConfig("cp-1", 2)).resolves.toBeNull();
  });

  it("round-trips SoC-meter sync get/save through ConnectorSettingsRepository", async () => {
    const service = new LocalChargePointService(
      new MemoryConnectorSettingsDatabase(),
    );

    await expect(service.getSocMeterSync("cp-1", 1)).resolves.toBe(true);

    await service.saveSocMeterSync("cp-1", 1, false);

    await expect(service.getSocMeterSync("cp-1", 1)).resolves.toBe(false);
    await expect(service.getSocMeterSync("cp-2", 2)).resolves.toBe(false);

    await service.saveSocMeterSync("cp-1", 1, true);

    await expect(service.getSocMeterSync("cp-1", 1)).resolves.toBe(true);
  });
});
