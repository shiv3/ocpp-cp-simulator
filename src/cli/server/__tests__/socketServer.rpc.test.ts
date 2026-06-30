import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@socket.io/bun-engine", () => ({
  Server: class MockEngine {},
}));

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { registerSocketHandlers } from "../socketServer";
import type { SimulatorConfigInput } from "../../../protocol";

type Handler = (...args: unknown[]) => void;
type RpcAck = { ok: true; result: unknown } | { ok: false; error: unknown };

class FakeIo {
  connectionHandler: Handler | null = null;

  readonly use = vi.fn(() => this);

  readonly on = vi.fn((event: string, handler: Handler) => {
    if (event === "connection") this.connectionHandler = handler;
    return this;
  });

  connect(socket: FakeSocket): void {
    if (!this.connectionHandler) throw new Error("missing connection handler");
    this.connectionHandler(socket);
  }
}

class FakeSocket {
  readonly handlers = new Map<string, Handler>();
  readonly handshake = { auth: {}, headers: {} };
  readonly join = vi.fn();
  readonly leave = vi.fn();

  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });

  emitRpc(request: unknown): Promise<RpcAck> {
    const handler = this.handlers.get("rpc");
    if (!handler) throw new Error("missing rpc handler");
    return new Promise((resolve) => {
      handler(request, resolve);
    });
  }
}

describe("socket.io rpc dispatch", () => {
  it("returns scenario templates without a CP", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, { registry, bus, database: null });
    io.connect(socket);

    const ack = await socket.emitRpc({
      method: "scenario.templates",
      params: {},
    });

    expect(ack.ok).toBe(true);
    expect(registry.list()).toHaveLength(0);
    if (!ack.ok) return;
    expect(ack.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "essential-cp-behavior" }),
      ]),
    );
  });

  it("returns redacted config.get results", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const store = { value: simulatorConfig() as SimulatorConfigInput | null };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      configRepository: memoryConfigRepository(store),
    });
    io.connect(socket);

    const ack = await socket.emitRpc({
      method: "config.get",
      params: {},
    });

    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const result = ack.result as {
      basicAuthSettings: Record<string, unknown>;
    };
    expect(result.basicAuthSettings).toEqual({
      enabled: true,
      username: "user",
    });
    expect("password" in result.basicAuthSettings).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("preserves the stored config password on omitted or blank config.save secrets", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const store = { value: simulatorConfig() as SimulatorConfigInput | null };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      configRepository: memoryConfigRepository(store),
    });
    io.connect(socket);

    const blankAck = await socket.emitRpc({
      method: "config.save",
      params: {
        config: {
          ...simulatorConfig(),
          ChargePointID: "cp-updated",
          basicAuthSettings: {
            enabled: true,
            username: "user",
            password: "",
          },
        },
      },
    });
    expect(blankAck.ok).toBe(true);

    const omittedAck = await socket.emitRpc({
      method: "config.save",
      params: {
        config: {
          ...simulatorConfig({ ChargePointID: "cp-updated-again" }),
          basicAuthSettings: {
            enabled: true,
            username: "user",
          },
        },
      },
    });
    expect(omittedAck.ok).toBe(true);

    expect(store.value?.ChargePointID).toBe("cp-updated-again");
    expect(store.value?.basicAuthSettings.password).toBe("secret");
  });

  it("dispatches A1.1d CP commands through the jsonMode whitelist", async () => {
    const bus = new EventBus();
    const service = {
      sendDiagnosticsStatusNotification: vi.fn(),
      sendFirmwareStatusNotification: vi.fn(),
      sendSecurityEventNotification: vi.fn(),
      sendSignCertificate: vi.fn().mockResolvedValue(undefined),
      loadScenario: vi.fn().mockReturnValue("file-scenario"),
      loadScenarioTemplate: vi.fn().mockReturnValue("template-scenario"),
      runScenario: vi.fn(),
    };
    const registry = {
      get: vi.fn((cpId: string) => (cpId === "cp-alpha" ? service : undefined)),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();
    const tmpDir = mkdtempSync(join(tmpdir(), "ocpp-rpc-scenario-"));
    const scenarioFile = join(tmpDir, "scenario.json");
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        id: "from-file",
        name: "From file",
        targetType: "connector",
        targetId: 1,
        nodes: [],
        edges: [],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      }),
    );

    try {
      registerSocketHandlers(io as never, {
        registry: registry as never,
        bus,
        database: null,
      });
      io.connect(socket);

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "diagnostics_status_notification",
          params: { status: "Uploading" },
        }),
      ).toMatchObject({ ok: true });
      expect(service.sendDiagnosticsStatusNotification).toHaveBeenCalledWith(
        "Uploading",
      );

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "firmware_status_notification",
          params: { status: "Downloaded" },
        }),
      ).toMatchObject({ ok: true });
      expect(service.sendFirmwareStatusNotification).toHaveBeenCalledWith(
        "Downloaded",
      );

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "security_event_notification",
          params: { type: "SettingSystemTime", techInfo: "clock adjusted" },
        }),
      ).toMatchObject({ ok: true });
      expect(service.sendSecurityEventNotification).toHaveBeenCalledWith(
        "SettingSystemTime",
        "clock adjusted",
      );

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "sign_certificate",
          params: { csr: "-----BEGIN CSR-----" },
        }),
      ).toMatchObject({ ok: true });
      expect(service.sendSignCertificate).toHaveBeenCalledWith(
        "-----BEGIN CSR-----",
      );

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "run_scenario_file",
          params: { connector: 1, file: scenarioFile },
        }),
      ).toMatchObject({ ok: true, result: { scenarioId: "file-scenario" } });
      expect(service.loadScenario).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ id: "from-file" }),
      );
      expect(service.runScenario).toHaveBeenCalledWith(1, "file-scenario");

      expect(
        await socket.emitRpc({
          cpId: "cp-alpha",
          method: "run_scenario_template",
          params: {
            connector: 2,
            templateId: "essential-cp-behavior",
            evSettings: { maxChargingPowerKw: 3 },
          },
        }),
      ).toMatchObject({
        ok: true,
        result: { scenarioId: "template-scenario" },
      });
      expect(service.loadScenarioTemplate).toHaveBeenCalledWith(
        "essential-cp-behavior",
        2,
        { maxChargingPowerKw: 3 },
      );
      expect(service.runScenario).toHaveBeenCalledWith(2, "template-scenario");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function simulatorConfig(
  overrides: Partial<SimulatorConfigInput> = {},
): SimulatorConfigInput {
  return {
    wsURL: "ws://example.test/ocpp",
    ChargePointID: "cp-alpha",
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username: "user",
      password: "secret",
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: {
      ChargePointIDs: [{ ChargePointID: "cp-alpha", ConnectorNumber: 1 }],
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

function memoryConfigRepository(store: { value: SimulatorConfigInput | null }) {
  return {
    async load() {
      return store.value;
    },
    async save(config: SimulatorConfigInput | null) {
      store.value = config;
    },
  };
}
