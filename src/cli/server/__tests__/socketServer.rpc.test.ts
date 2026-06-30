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
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
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
    const facade = {
      loadConfig: vi.fn().mockResolvedValue(secretSimulatorConfig()),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      chargePointService: facade as never,
    });
    io.connect(socket);

    const ack = await socket.emitRpc({
      method: "config.get",
      params: {},
    });

    expect(ack.ok).toBe(true);
    expect(facade.loadConfig).toHaveBeenCalledTimes(1);
    if (!ack.ok) return;
    const result = ack.result as {
      wsURL: string;
      basicAuthSettings: Record<string, unknown>;
    };
    expect(result.basicAuthSettings).toEqual({
      enabled: true,
      username: "user",
    });
    expect(result.wsURL).toBe("ws://example.test/ocpp");
    expect("password" in result.basicAuthSettings).toBe(false);
    expectNoWireSecrets(result);
  });

  it("deep-redacts every socket read and subscribe snapshot that carries CP config", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const snapshot = secretChargePointSnapshot();
    const facade = {
      listChargePoints: vi.fn().mockResolvedValue([snapshot]),
      getChargePoint: vi.fn().mockResolvedValue(snapshot),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      chargePointService: facade as never,
    });
    io.connect(socket);

    const reads = [
      {
        label: "cp.list",
        request: { method: "cp.list", params: {} },
      },
      {
        label: "getChargePoint/status",
        request: { cpId: "cp-redact", method: "status", params: {} },
      },
      {
        label: "registry subscribe snapshot",
        request: { method: "events.subscribe", params: { scope: "registry" } },
      },
      {
        label: "star subscribe snapshot",
        request: { method: "events.subscribe", params: { scope: "*" } },
      },
    ];

    for (const { label, request } of reads) {
      const ack = await socket.emitRpc(request);
      expect(ack.ok, label).toBe(true);
      if (!ack.ok) continue;
      expectNoWireSecrets(ack.result);
    }

    expect(facade.listChargePoints).toHaveBeenCalledTimes(3);
    expect(facade.getChargePoint).toHaveBeenCalledWith("cp-redact");
  });

  it("accepts create/update secrets as write-only inputs without echoing them", async () => {
    const bus = new EventBus();
    const existing = {
      getInit: () => ({
        cpId: "cp-write",
        wsUrl: "wss://old-user:wire-url-secret@example.test/ocpp",
        connectors: 1,
        vendor: "Vendor",
        model: "Model",
        basicAuth: { username: "existing-user", password: "wire-basic-secret" },
        ocppVersion: "OCPP-1.6J",
        securityProfile: 3,
        authorizationKey: "wire-authorization-key",
        cpoName: "Example CPO",
        tls: {
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
          serverName: "old.example.test",
        },
        tlsCaPath: "/safe/ca.pem",
        tlsCertPath: "/safe/cert.pem",
        tlsKeyPath: "/safe/key.pem",
      }),
    };
    const registry = {
      get: vi.fn((cpId: string) => (cpId === "cp-write" ? existing : null)),
      has: vi.fn(() => false),
      list: vi.fn(() => []),
    };
    const facade = {
      createChargePoint: vi.fn().mockResolvedValue(undefined),
      updateChargePoint: vi.fn().mockResolvedValue(undefined),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry: registry as never,
      bus,
      database: null,
      chargePointService: facade as never,
    });
    io.connect(socket);

    const createAck = await socket.emitRpc({
      method: "cp.create",
      params: {
        cpId: "cp-create",
        wsUrl: "wss://new-user:wire-url-secret@example.test/ocpp",
        connectors: 1,
        vendor: "Vendor",
        model: "Model",
        basicAuth: { username: "new-user", password: "wire-basic-secret" },
        ocppVersion: "OCPP-1.6J",
        securityProfile: 3,
        authorizationKey: "wire-authorization-key",
        tls: {
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
          serverName: "new.example.test",
        },
      },
    });
    expect(createAck.ok).toBe(true);
    if (createAck.ok) expectNoWireSecrets(createAck.result);
    expect(facade.createChargePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        cpId: "cp-create",
        basicAuth: { username: "new-user", password: "wire-basic-secret" },
        tls: expect.objectContaining({
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
        }),
      }),
    );

    const blankUpdateAck = await socket.emitRpc({
      method: "cp.update",
      params: {
        cpId: "cp-write",
        wsUrl: "wss://updated.example.test/ocpp",
        connectors: 2,
        vendor: "Vendor",
        model: "Model",
        basicAuth: { username: "updated-user", password: "" },
        ocppVersion: "OCPP-1.6J",
        tls: { serverName: "updated.example.test" },
      },
    });
    expect(blankUpdateAck.ok).toBe(true);
    if (blankUpdateAck.ok) expectNoWireSecrets(blankUpdateAck.result);

    const omittedUpdateAck = await socket.emitRpc({
      method: "cp.update",
      params: {
        cpId: "cp-write",
        wsUrl: "wss://omitted.example.test/ocpp",
        connectors: 2,
        vendor: "Vendor",
        model: "Model",
        ocppVersion: "OCPP-1.6J",
      },
    });
    expect(omittedUpdateAck.ok).toBe(true);
    if (omittedUpdateAck.ok) expectNoWireSecrets(omittedUpdateAck.result);

    expect(facade.updateChargePoint).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cpId: "cp-write",
        basicAuth: {
          username: "updated-user",
          password: "wire-basic-secret",
        },
        tls: expect.objectContaining({
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
          serverName: "updated.example.test",
        }),
      }),
    );
    expect(facade.updateChargePoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cpId: "cp-write",
        basicAuth: {
          username: "existing-user",
          password: "wire-basic-secret",
        },
        tls: expect.objectContaining({
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
          serverName: "old.example.test",
        }),
      }),
    );
  });

  it("redacts facade CP snapshots at the socket boundary", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const snapshot = chargePointSnapshot();
    const facade = {
      listChargePoints: vi.fn().mockResolvedValue([snapshot]),
      getChargePoint: vi.fn().mockResolvedValue(snapshot),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      chargePointService: facade as never,
    });
    io.connect(socket);

    const listAck = await socket.emitRpc({
      method: "cp.list",
      params: {},
    });
    const statusAck = await socket.emitRpc({
      cpId: "cp-redact",
      method: "status",
      params: {},
    });

    expect(listAck.ok).toBe(true);
    expect(statusAck.ok).toBe(true);
    expect(facade.listChargePoints).toHaveBeenCalledTimes(1);
    expect(facade.getChargePoint).toHaveBeenCalledWith("cp-redact");
    if (!listAck.ok || !statusAck.ok) return;
    expect(listAck.result).toEqual([
      expect.objectContaining({
        cpId: "cp-redact",
        wsUrl: "ws://example.test/ocpp",
        basicAuth: { username: "user" },
      }),
    ]);
    expect(statusAck.result).toEqual(
      expect.objectContaining({
        id: "cp-redact",
        config: expect.objectContaining({
          wsUrl: "ws://example.test/ocpp",
          basicAuth: { username: "user" },
        }),
      }),
    );
    expect(JSON.stringify(listAck.result)).not.toContain("secret");
    expect(JSON.stringify(statusAck.result)).not.toContain("secret");
  });

  it("dispatches representative per-CP and global methods through the facade", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const facade = {
      sendDiagnosticsStatusNotification: vi.fn().mockResolvedValue(undefined),
      setConnectorSocMeterSync: vi.fn().mockResolvedValue(undefined),
      getScenarioTemplates: vi.fn().mockResolvedValue([
        {
          id: "template-a",
          name: "Template A",
          description: "Template fixture",
        },
      ]),
    };
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, {
      registry,
      bus,
      database: null,
      chargePointService: facade as never,
    });
    io.connect(socket);

    await expect(
      socket.emitRpc({
        cpId: "cp-alpha",
        method: "diagnostics_status_notification",
        params: { status: "Uploading" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(facade.sendDiagnosticsStatusNotification).toHaveBeenCalledWith(
      "cp-alpha",
      "Uploading",
    );

    await expect(
      socket.emitRpc({
        cpId: "cp-alpha",
        method: "set_soc_meter_sync",
        params: { connector: 1, enabled: true },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(facade.setConnectorSocMeterSync).toHaveBeenCalledWith(
      "cp-alpha",
      1,
      true,
    );

    const templatesAck = await socket.emitRpc({
      method: "scenario.templates",
      params: {},
    });
    expect(templatesAck).toMatchObject({
      ok: true,
      result: [
        {
          id: "template-a",
          name: "Template A",
          description: "Template fixture",
        },
      ],
    });
    expect(facade.getScenarioTemplates).toHaveBeenCalledTimes(1);
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

function secretSimulatorConfig(): SimulatorConfigInput {
  return simulatorConfig({
    wsURL: "ws://config-user:wire-config-url-secret@example.test/ocpp",
    basicAuthSettings: {
      enabled: true,
      username: "user",
      password: "wire-config-secret",
    },
  });
}

function memoryConfigRepository(store: { value: SimulatorConfigInput | null }) {
  const listeners = new Set<(value: SimulatorConfigInput | null) => void>();
  return {
    async load() {
      return store.value;
    },
    async save(config: SimulatorConfigInput | null) {
      store.value = config;
      listeners.forEach((listener) => listener(config));
    },
    subscribe(handler: (config: SimulatorConfigInput | null) => void) {
      listeners.add(handler);
      void Promise.resolve(store.value).then(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

function chargePointSnapshot() {
  return {
    id: "cp-redact",
    status: "Available",
    error: "",
    connectors: [],
    heartbeat: { intervalSeconds: 0, lastSentAt: null },
    config: {
      wsUrl: "ws://user:secret@example.test/ocpp",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: { username: "user", password: "secret" },
      ocppVersion: "OCPP-1.6J",
      bootNotification: null,
    },
  };
}

function secretChargePointSnapshot(): ChargePointSnapshot {
  return {
    id: "cp-redact",
    status: "Available" as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
    heartbeat: { intervalSeconds: 0, lastSentAt: null },
    config: {
      wsUrl: "ws://user:wire-url-secret@example.test/ocpp",
      centralSystemUrl:
        "https://central:wire-central-secret@central.example.test/ocpp",
      soapCallbackUrl:
        "https://soap:wire-soap-secret@cp.example.test/ocpp/soap",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: { username: "user", password: "wire-basic-secret" },
      ocppVersion: "OCPP-1.6J",
      securityProfile: 3,
      cpoName: "Example CPO",
      tlsCaPath: "/safe/ca.pem",
      tlsCertPath: "/safe/cert.pem",
      tlsKeyPath: "/safe/key.pem",
      bootNotification: null,
      tls: {
        ca: "wire-tls-ca-material",
        cert: "wire-tls-cert-material",
        key: "wire-tls-key-material",
      },
      authorizationKey: "wire-authorization-key",
    } as ChargePointSnapshot["config"],
  };
}

const WIRE_SECRET_VALUES = [
  "wire-basic-secret",
  "wire-url-secret",
  "wire-central-secret",
  "wire-soap-secret",
  "wire-config-secret",
  "wire-config-url-secret",
  "wire-tls-ca-material",
  "wire-tls-cert-material",
  "wire-tls-key-material",
  "wire-authorization-key",
];

function expectNoWireSecrets(value: unknown): void {
  expect(secretValueHits(value)).toEqual([]);
  expect(passwordKeyHits(value)).toEqual([]);
}

function secretValueHits(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return WIRE_SECRET_VALUES.filter((secret) => value.includes(secret)).map(
      (secret) => `${path} contains ${secret}`,
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      secretValueHits(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => secretValueHits(nested, `${path}.${key}`),
    );
  }
  return [];
}

function passwordKeyHits(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      passwordKeyHits(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => [
        ...(key === "password" ? [`${path}.${key}`] : []),
        ...passwordKeyHits(nested, `${path}.${key}`),
      ],
    );
  }
  return [];
}
