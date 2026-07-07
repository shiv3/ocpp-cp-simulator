/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChargePointEvent } from "../interfaces/ChargePointService";
import {
  RpcFailure,
  type CpListItem,
  type EventEnvelope,
  type StatusWire,
  type SubscribeResult,
  type WireSimulatorConfig,
} from "../../protocol";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";

type Handler = (...args: any[]) => void;

interface PendingAck {
  event: string;
  request: any;
  timeoutMs: number | null;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface ExpectedRpcRequest {
  cpId?: string;
  method: string;
  params: Record<string, unknown>;
}

interface RemoteReachCase {
  name: string;
  invoke: (service: RemoteChargePointService) => unknown;
  expected: ExpectedRpcRequest[];
  results: unknown[];
}

const socketMockState = vi.hoisted(() => {
  class MockSocket {
    connected = false;
    readonly handlers = new Map<string, Set<Handler>>();
    readonly managerHandlers = new Map<string, Set<Handler>>();
    readonly acks: PendingAck[] = [];
    private timeoutMs: number | null = null;

    readonly io = {
      on: vi.fn((event: string, handler: Handler) => {
        this.add(this.managerHandlers, event, handler);
        return this.io;
      }),
      off: vi.fn((event: string, handler: Handler) => {
        this.managerHandlers.get(event)?.delete(handler);
        return this.io;
      }),
    };

    readonly on = vi.fn((event: string, handler: Handler) => {
      this.add(this.handlers, event, handler);
      return this;
    });

    readonly off = vi.fn((event: string, handler: Handler) => {
      this.handlers.get(event)?.delete(handler);
      return this;
    });

    readonly timeout = vi.fn((timeoutMs: number) => {
      this.timeoutMs = timeoutMs;
      return this;
    });

    readonly emitWithAck = vi.fn((event: string, request: any) => {
      const timeoutMs = this.timeoutMs;
      this.timeoutMs = null;
      return new Promise((resolve, reject) => {
        this.acks.push({ event, request, timeoutMs, resolve, reject });
      });
    });

    readonly connect = vi.fn(() => {
      if (!this.connected) {
        this.connected = true;
        this.trigger("connect");
      }
      return this;
    });

    readonly disconnect = vi.fn(() => {
      if (this.connected) {
        this.connected = false;
        this.trigger("disconnect", "io client disconnect");
      }
      return this;
    });

    trigger(event: string, ...args: unknown[]): void {
      if (event === "connect") this.connected = true;
      if (event === "disconnect") this.connected = false;
      this.handlers.get(event)?.forEach((handler) => handler(...args));
    }

    triggerManager(event: string, ...args: unknown[]): void {
      this.managerHandlers.get(event)?.forEach((handler) => handler(...args));
    }

    serverEvent(envelope: EventEnvelope): void {
      this.trigger("event", envelope);
    }

    private add(
      map: Map<string, Set<Handler>>,
      event: string,
      handler: Handler,
    ): void {
      const handlers = map.get(event) ?? new Set<Handler>();
      handlers.add(handler);
      map.set(event, handlers);
    }
  }

  const sockets: MockSocket[] = [];
  const io = vi.fn(() => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  });

  return { sockets, io };
});

vi.mock("socket.io-client", () => ({
  io: socketMockState.io,
}));

import { RemoteChargePointService } from "./RemoteChargePointService";

function latestSocket() {
  const socket = socketMockState.sockets[socketMockState.sockets.length - 1];
  if (!socket) throw new Error("socket was not created");
  return socket;
}

function nextAck(): PendingAck {
  const ack = latestSocket().acks.shift();
  if (!ack) throw new Error("missing pending ack");
  return ack;
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function cpItem(cpId = "cp-1", status = "Available"): CpListItem {
  return {
    cpId,
    status,
    wsUrl: "ws://example.test/ocpp",
    connectors: 1,
    vendor: "Vendor",
    model: "Model",
    basicAuth: null,
    bootNotification: null,
  };
}

function statusWire(cpId = "cp-1", status = "Available"): StatusWire {
  return {
    id: cpId,
    status,
    error: "",
    connectors: [],
    config: {
      wsUrl: "ws://example.test/ocpp",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
      bootNotification: null,
    },
  };
}

function connectorWire(
  id = 1,
  overrides: Partial<StatusWire["connectors"][number]> = {},
): StatusWire["connectors"][number] {
  return {
    id,
    status: "Available",
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: true,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
    ...overrides,
  };
}

function scenarioDefinition(id = "scenario-1"): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    targetType: "connector",
    targetId: 1,
    nodes: [],
    edges: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:01.000Z",
    enabled: true,
  };
}

function scenarioDefinitionsPayload(
  ...definitions: ScenarioDefinition[]
): Record<string, unknown>[] {
  return definitions as unknown as Record<string, unknown>[];
}

function wireSimulatorConfig(
  cpId = "cp-1",
  username = "user",
): WireSimulatorConfig {
  return {
    wsURL: "ws://example.test/ocpp",
    ChargePointID: cpId,
    connectorNumber: 1,
    tagID: "TAG-1",
    ocppVersion: "OCPP-1.6J",
    basicAuthSettings: {
      enabled: true,
      username,
    },
    autoMeterValueSetting: {
      enabled: false,
      interval: 30,
      value: 10,
    },
    Experimental: null,
    BootNotification: null,
  };
}

function autoMeterConfig(): AutoMeterValueConfig {
  return {
    enabled: true,
    curvePoints: [
      { time: 0, value: 0 },
      { time: 900, value: 18 },
    ],
    intervalSeconds: 30,
    autoCalculateInterval: false,
  };
}

function evSettings() {
  return {
    modelName: "Test EV",
    batteryCapacityKwh: 64,
    maxChargingPowerKw: 90,
    initialSoc: 12,
    targetSoc: 88,
  };
}

function subscribeResult(scope = "cp-1"): SubscribeResult {
  return {
    subscribed: [scope],
    snapshot: {
      cps: [cpItem("cp-1")],
      perCp: scope === "registry" ? {} : { "cp-1": statusWire("cp-1") },
    },
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

beforeEach(() => {
  socketMockState.sockets.splice(0);
  socketMockState.io.mockClear();
});

describe("RemoteChargePointService socket.io rpc", () => {
  it("round-trips every wire-meaningful port method through the Remote adapter", async () => {
    const definition = scenarioDefinition("reach-definition");
    const definitionTwo = scenarioDefinition("reach-definition-two");
    const autoMeter = autoMeterConfig();
    const ev = evSettings();
    const statusWithConnector = {
      ...statusWire("cp-1"),
      connectors: [
        connectorWire(1, {
          evSettings: ev,
          autoMeterValueConfig: autoMeter as unknown as Record<string, unknown>,
          chargingProfiles: [{ id: 99 }],
        }),
      ],
    };

    const cases: RemoteReachCase[] = [
      {
        name: "listChargePoints",
        invoke: (service) => service.listChargePoints(),
        expected: [{ method: "cp.list", params: {} }],
        results: [[cpItem("cp-1")]],
      },
      {
        name: "getChargePoint",
        invoke: (service) => service.getChargePoint("cp-1"),
        expected: [{ cpId: "cp-1", method: "status", params: {} }],
        results: [statusWire("cp-1")],
      },
      {
        name: "createChargePoint",
        invoke: (service) =>
          service.createChargePoint({
            cpId: "cp-new",
            wsUrl: "ws://example.test/ocpp",
            connectors: 1,
            vendor: "Vendor",
            model: "Model",
            basicAuth: { username: "user", password: "secret" },
          }),
        expected: [
          {
            method: "cp.create",
            params: {
              cpId: "cp-new",
              wsUrl: "ws://example.test/ocpp",
              connectors: 1,
              vendor: "Vendor",
              model: "Model",
              basicAuth: { username: "user", password: "secret" },
            },
          },
        ],
        results: [{ cpId: "cp-new" }],
      },
      {
        name: "updateChargePoint",
        invoke: (service) =>
          service.updateChargePoint({
            cpId: "cp-1",
            wsUrl: "ws://example.test/updated",
            connectors: 2,
            vendor: "Vendor",
            model: "Model",
            basicAuth: { username: "user" },
          }),
        expected: [
          {
            method: "cp.update",
            params: {
              cpId: "cp-1",
              wsUrl: "ws://example.test/updated",
              connectors: 2,
              vendor: "Vendor",
              model: "Model",
              basicAuth: { username: "user" },
            },
          },
        ],
        results: [{ cpId: "cp-1" }],
      },
      {
        name: "removeChargePoint",
        invoke: (service) => service.removeChargePoint("cp-1"),
        expected: [{ method: "cp.delete", params: { cpId: "cp-1" } }],
        results: [{ ok: true }],
      },
      {
        name: "ping",
        invoke: (service) => service.ping(),
        expected: [{ method: "cp.list", params: {} }],
        results: [[]],
      },
      {
        name: "resetAllState",
        invoke: (service) => service.resetAllState(),
        expected: [{ method: "state.reset", params: {} }],
        results: [{ ok: true }],
      },
      {
        name: "clearStoredLogs",
        invoke: (service) => service.clearStoredLogs("cp-1"),
        expected: [{ method: "logs.clear", params: { cpId: "cp-1" } }],
        results: [{ ok: true }],
      },
      {
        name: "listStoredLogs",
        invoke: (service) => service.listStoredLogs("cp-1"),
        expected: [{ method: "logs.get", params: { cpId: "cp-1" } }],
        results: [[]],
      },
      {
        name: "loadConfig",
        invoke: (service) => service.loadConfig(),
        expected: [{ method: "config.get", params: {} }],
        results: [null],
      },
      {
        name: "saveConfig",
        invoke: (service) =>
          service.saveConfig({
            wsURL: "ws://example.test/ocpp",
            ChargePointID: "cp-1",
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
            Experimental: null,
            BootNotification: null,
          }),
        expected: [
          {
            method: "config.save",
            params: {
              config: {
                wsURL: "ws://example.test/ocpp",
                ChargePointID: "cp-1",
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
                Experimental: null,
                BootNotification: null,
              },
            },
          },
        ],
        results: [{ ok: true }],
      },
      {
        name: "subscribeConfig",
        invoke: (service) => service.subscribeConfig(() => undefined),
        expected: [
          { method: "events.subscribe", params: { scope: "config" } },
          { method: "config.get", params: {} },
        ],
        results: [subscribeResult("config"), null],
      },
      {
        name: "connect",
        invoke: (service) => service.connect("cp-1"),
        expected: [{ cpId: "cp-1", method: "connect", params: {} }],
        results: [undefined],
      },
      {
        name: "disconnect",
        invoke: (service) => service.disconnect("cp-1"),
        expected: [{ cpId: "cp-1", method: "disconnect", params: {} }],
        results: [undefined],
      },
      {
        name: "reset",
        invoke: (service) => service.reset("cp-1"),
        expected: [
          { cpId: "cp-1", method: "disconnect", params: {} },
          { cpId: "cp-1", method: "connect", params: {} },
        ],
        results: [undefined, undefined],
      },
      {
        name: "sendHeartbeat",
        invoke: (service) => service.sendHeartbeat("cp-1"),
        expected: [{ cpId: "cp-1", method: "heartbeat", params: {} }],
        results: [undefined],
      },
      {
        name: "startHeartbeat",
        invoke: (service) => service.startHeartbeat("cp-1", 30),
        expected: [
          {
            cpId: "cp-1",
            method: "start_heartbeat",
            params: { interval: 30 },
          },
        ],
        results: [undefined],
      },
      {
        name: "stopHeartbeat",
        invoke: (service) => service.stopHeartbeat("cp-1"),
        expected: [{ cpId: "cp-1", method: "stop_heartbeat", params: {} }],
        results: [undefined],
      },
      {
        name: "authorize",
        invoke: (service) => service.authorize("cp-1", "TAG-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "authorize",
            params: { tagId: "TAG-1" },
          },
        ],
        results: [undefined],
      },
      {
        name: "startTransaction",
        invoke: (service) => service.startTransaction("cp-1", 1, "TAG-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "start_transaction",
            params: { connector: 1, tagId: "TAG-1" },
          },
        ],
        results: [undefined],
      },
      {
        name: "stopTransaction",
        invoke: (service) => service.stopTransaction("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "stop_transaction",
            params: { connector: 1 },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendStatusNotification",
        invoke: (service) =>
          service.sendStatusNotification("cp-1", 0, OCPPStatus.Available),
        expected: [
          {
            cpId: "cp-1",
            method: "update_connector_status",
            params: { connector: 0, status: "Available" },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendDiagnosticsStatusNotification",
        invoke: (service) =>
          service.sendDiagnosticsStatusNotification("cp-1", "Uploading"),
        expected: [
          {
            cpId: "cp-1",
            method: "diagnostics_status_notification",
            params: { status: "Uploading" },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendFirmwareStatusNotification",
        invoke: (service) =>
          service.sendFirmwareStatusNotification("cp-1", "Downloaded"),
        expected: [
          {
            cpId: "cp-1",
            method: "firmware_status_notification",
            params: { status: "Downloaded" },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendSecurityEventNotification",
        invoke: (service) =>
          service.sendSecurityEventNotification(
            "cp-1",
            "SettingSystemTime",
            "clock adjusted",
          ),
        expected: [
          {
            cpId: "cp-1",
            method: "security_event_notification",
            params: { type: "SettingSystemTime", techInfo: "clock adjusted" },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendSignCertificate",
        invoke: (service) => service.sendSignCertificate("cp-1", "CSR"),
        expected: [
          {
            cpId: "cp-1",
            method: "sign_certificate",
            params: { csr: "CSR" },
          },
        ],
        results: [undefined],
      },
      {
        name: "setMeterValue",
        invoke: (service) => service.setMeterValue("cp-1", 1, 1200),
        expected: [
          {
            cpId: "cp-1",
            method: "set_meter_value",
            params: { connector: 1, value: 1200 },
          },
        ],
        results: [undefined],
      },
      {
        name: "sendMeterValue",
        invoke: (service) => service.sendMeterValue("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "send_meter_value",
            params: { connector: 1 },
          },
        ],
        results: [undefined],
      },
      {
        name: "removeConnector",
        invoke: (service) => service.removeConnector("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "remove_connector",
            params: { connector: 1 },
          },
        ],
        results: [{ removed: true }],
      },
      {
        name: "setEVSettings",
        invoke: (service) => service.setEVSettings("cp-1", 1, ev),
        expected: [
          {
            cpId: "cp-1",
            method: "set_ev_settings",
            params: { connector: 1, settings: ev },
          },
        ],
        results: [undefined],
      },
      {
        name: "getEVSettings",
        invoke: (service) => service.getEVSettings("cp-1", 1),
        expected: [{ cpId: "cp-1", method: "status", params: {} }],
        results: [statusWithConnector],
      },
      {
        name: "applyDefaultEVSettings",
        invoke: (service) => service.applyDefaultEVSettings(ev),
        expected: [
          {
            method: "ev_settings.apply_default",
            params: { settings: ev },
          },
        ],
        results: [undefined],
      },
      {
        name: "setAutoMeterValueConfig",
        invoke: (service) =>
          service.setAutoMeterValueConfig("cp-1", 1, autoMeter),
        expected: [
          {
            cpId: "cp-1",
            method: "set_auto_meter_config",
            params: { connector: 1, config: autoMeter },
          },
        ],
        results: [undefined],
      },
      {
        name: "getAutoMeterValueConfig",
        invoke: (service) => service.getAutoMeterValueConfig("cp-1", 1),
        expected: [{ cpId: "cp-1", method: "status", params: {} }],
        results: [statusWithConnector],
      },
      {
        name: "getAutoMeterConfig",
        invoke: (service) => service.getAutoMeterConfig("cp-1", 1),
        expected: [
          {
            method: "connector_settings.auto_meter.get",
            params: { cpId: "cp-1", connectorId: 1 },
          },
        ],
        results: [autoMeter],
      },
      {
        name: "saveAutoMeterConfig",
        invoke: (service) => service.saveAutoMeterConfig("cp-1", 1, autoMeter),
        expected: [
          {
            method: "connector_settings.auto_meter.save",
            params: { cpId: "cp-1", connectorId: 1, config: autoMeter },
          },
        ],
        results: [{ ok: true }],
      },
      {
        name: "setAutoResetToAvailable",
        invoke: (service) => service.setAutoResetToAvailable("cp-1", 1, false),
        expected: [
          {
            cpId: "cp-1",
            method: "set_auto_reset_to_available",
            params: { connector: 1, enabled: false },
          },
        ],
        results: [undefined],
      },
      {
        name: "setConnectorMode",
        invoke: (service) => service.setConnectorMode("cp-1", 1, "scenario"),
        expected: [
          {
            cpId: "cp-1",
            method: "set_mode",
            params: { connector: 1, mode: "scenario" },
          },
        ],
        results: [undefined],
      },
      {
        name: "setConnectorSoc",
        invoke: (service) => service.setConnectorSoc("cp-1", 1, 42),
        expected: [
          {
            cpId: "cp-1",
            method: "set_soc",
            params: { connector: 1, soc: 42 },
          },
        ],
        results: [undefined],
      },
      {
        name: "setConnectorSocMeterSync",
        invoke: (service) => service.setConnectorSocMeterSync("cp-1", 1, true),
        expected: [
          {
            cpId: "cp-1",
            method: "set_soc_meter_sync",
            params: { connector: 1, enabled: true },
          },
        ],
        results: [undefined],
      },
      {
        name: "getSocMeterSync",
        invoke: (service) => service.getSocMeterSync("cp-1", 1),
        expected: [
          {
            method: "connector_settings.soc_meter_sync.get",
            params: { cpId: "cp-1", connectorId: 1 },
          },
        ],
        results: [true],
      },
      {
        name: "saveSocMeterSync",
        invoke: (service) => service.saveSocMeterSync("cp-1", 1, true),
        expected: [
          {
            method: "connector_settings.soc_meter_sync.save",
            params: { cpId: "cp-1", connectorId: 1, enabled: true },
          },
        ],
        results: [{ ok: true }],
      },
      {
        name: "getChargingProfiles",
        invoke: (service) => service.getChargingProfiles("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "get_charging_profiles",
            params: { connector: 1 },
          },
        ],
        results: [[{ id: 99 }]],
      },
      {
        name: "getStateHistory",
        invoke: (service) => service.getStateHistory("cp-1", { limit: 10 }),
        expected: [
          {
            cpId: "cp-1",
            method: "get_state_history",
            params: { options: { limit: 10 } },
          },
        ],
        results: [[]],
      },
      {
        name: "listScenarioDefinitions",
        invoke: (service) => service.listScenarioDefinitions("cp-1", null),
        expected: [
          {
            method: "scenario.definitions.list",
            params: { cpId: "cp-1", connectorId: null },
          },
        ],
        results: [[]],
      },
      {
        name: "saveScenarioDefinition",
        invoke: (service) =>
          service.saveScenarioDefinition("cp-1", 1, definition),
        expected: [
          {
            method: "scenario.definitions.save",
            params: { cpId: "cp-1", connectorId: 1, definition },
          },
        ],
        results: [definition],
      },
      {
        name: "replaceConnectorScenarioDefinitions",
        invoke: (service) =>
          service.replaceConnectorScenarioDefinitions("cp-1", 1, [
            definition,
            definitionTwo,
          ]),
        expected: [
          {
            method: "scenario.definitions.replace",
            params: {
              cpId: "cp-1",
              connectorId: 1,
              definitions: [definition, definitionTwo],
            },
          },
        ],
        results: [[definition, definitionTwo]],
      },
      {
        name: "deleteScenarioDefinition",
        invoke: (service) =>
          service.deleteScenarioDefinition("cp-1", 1, definition.id),
        expected: [
          {
            method: "scenario.definitions.delete",
            params: {
              cpId: "cp-1",
              connectorId: 1,
              definitionId: definition.id,
            },
          },
        ],
        results: [{ ok: true }],
      },
      {
        name: "subscribeScenarioDefinitions",
        invoke: (service) =>
          service.subscribeScenarioDefinitions("cp-1", 1, () => undefined),
        expected: [
          {
            method: "events.subscribe",
            params: { scope: "scenario-definitions" },
          },
          {
            method: "scenario.definitions.list",
            params: { cpId: "cp-1", connectorId: 1 },
          },
        ],
        results: [subscribeResult("scenario-definitions"), []],
      },
      {
        name: "getScenarioTemplates",
        invoke: (service) => service.getScenarioTemplates(),
        expected: [{ method: "scenario.templates", params: {} }],
        results: [[]],
      },
      {
        name: "loadScenarioTemplate",
        invoke: (service) =>
          service.loadScenarioTemplate("cp-1", "template-1", 1, {
            maxChargingPowerKw: 3,
          }),
        expected: [
          {
            cpId: "cp-1",
            method: "load_scenario_template",
            params: {
              connector: 1,
              templateId: "template-1",
              evSettings: { maxChargingPowerKw: 3 },
            },
          },
        ],
        results: [{ scenarioId: "template-scenario" }],
      },
      {
        name: "loadScenario",
        invoke: (service) => service.loadScenario("cp-1", 1, definition),
        expected: [
          {
            cpId: "cp-1",
            method: "load_scenario",
            params: { connector: 1, scenario: definition },
          },
        ],
        results: [{ scenarioId: "loaded-scenario" }],
      },
      {
        name: "listScenarios",
        invoke: (service) => service.listScenarios("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "list_scenarios",
            params: { connector: 1 },
          },
        ],
        results: [[]],
      },
      {
        name: "runScenario",
        invoke: (service) => service.runScenario("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "run_scenario",
            params: { connector: 1, scenarioId: "scenario-1" },
          },
        ],
        results: [undefined],
      },
      {
        name: "runScenarioFile",
        invoke: (service) =>
          service.runScenarioFile("cp-1", "/tmp/scenario.json", {
            connectorId: 1,
          }),
        expected: [
          {
            cpId: "cp-1",
            method: "run_scenario_file",
            params: { connector: 1, file: "/tmp/scenario.json" },
          },
        ],
        results: [{ scenarioId: "file-scenario" }],
      },
      {
        name: "runScenarioTemplate",
        invoke: (service) =>
          service.runScenarioTemplate("cp-1", "template-1", {
            connectorId: 1,
            evSettings: { maxChargingPowerKw: 3 },
          }),
        expected: [
          {
            cpId: "cp-1",
            method: "run_scenario_template",
            params: {
              connector: 1,
              templateId: "template-1",
              evSettings: { maxChargingPowerKw: 3 },
            },
          },
        ],
        results: [{ scenarioId: "template-scenario" }],
      },
      {
        name: "stopScenario",
        invoke: (service) => service.stopScenario("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "stop_scenario",
            params: { connector: 1, scenarioId: "scenario-1" },
          },
        ],
        results: [undefined],
      },
      {
        name: "stepScenario",
        invoke: (service) => service.stepScenario("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "step_scenario",
            params: { connector: 1, scenarioId: "scenario-1", force: false },
          },
        ],
        results: [undefined],
      },
      {
        name: "stopAllScenarios",
        invoke: (service) => service.stopAllScenarios("cp-1", 1),
        expected: [
          {
            cpId: "cp-1",
            method: "stop_all_scenarios",
            params: { connector: 1 },
          },
        ],
        results: [undefined],
      },
      {
        name: "removeScenario",
        invoke: (service) => service.removeScenario("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "remove_scenario",
            params: { connector: 1, scenarioId: "scenario-1" },
          },
        ],
        results: [{ removed: true }],
      },
      {
        name: "getScenarioStatus",
        invoke: (service) => service.getScenarioStatus("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "scenario_status",
            params: { connector: 1, scenarioId: "scenario-1" },
          },
        ],
        results: [null],
      },
      {
        name: "getScenario",
        invoke: (service) => service.getScenario("cp-1", 1, "scenario-1"),
        expected: [
          {
            cpId: "cp-1",
            method: "get_scenario",
            params: { connector: 1, scenarioId: "scenario-1" },
          },
        ],
        results: [definition],
      },
      {
        name: "subscribe",
        invoke: (service) => service.subscribe("cp-1", () => undefined),
        expected: [{ method: "events.subscribe", params: { scope: "cp-1" } }],
        results: [subscribeResult("cp-1")],
      },
      {
        name: "subscribeRegistry",
        invoke: (service) => service.subscribeRegistry(() => undefined),
        expected: [
          { method: "events.subscribe", params: { scope: "registry" } },
        ],
        results: [subscribeResult("registry")],
      },
    ];

    for (const testCase of cases) {
      socketMockState.sockets.splice(0);
      socketMockState.io.mockClear();
      const service = new RemoteChargePointService("http://127.0.0.1:9700");
      const returned = testCase.invoke(service);

      for (const [index, expected] of testCase.expected.entries()) {
        const ack = latestSocket().acks.shift();
        if (!ack) {
          throw new Error(
            `missing pending ack for ${testCase.name} -> ${expected.method}`,
          );
        }
        expect(ack.event, testCase.name).toBe("rpc");
        expect(ack.request, testCase.name).toEqual(expected);
        ack.resolve({ ok: true, result: testCase.results[index] });
        await flush();
        await flush();
      }

      if (isPromiseLike(returned)) await returned;
      service.dispose();
    }
  });

  it("resolves rpc calls from an ok ack", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");
    const ack = nextAck();

    expect(ack.event).toBe("rpc");
    expect(ack.request).toEqual({
      cpId: "cp-1",
      method: "connect",
      params: {},
    });

    ack.resolve({ ok: true, result: undefined });
    await expect(promise).resolves.toBeUndefined();
  });

  it("uses explicit handshake auth when supplied by the CLI client", () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700", {
      basicAuth: { username: "admin", password: "secret" },
    });

    expect(socketMockState.io).toHaveBeenCalledWith(
      "http://127.0.0.1:9700",
      expect.objectContaining({
        auth: { username: "admin", password: "secret" },
      }),
    );

    service.dispose();
  });

  it("returns raw rpc acks without translating server failures", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.runRawRpc(
      "load_scenario",
      { connector: 1, file: "/tmp/scenario.json" },
      "cp-1",
    );
    const ack = nextAck();

    expect(ack.event).toBe("rpc");
    expect(ack.request).toEqual({
      cpId: "cp-1",
      method: "load_scenario",
      params: { connector: 1, file: "/tmp/scenario.json" },
    });

    ack.resolve({
      ok: false,
      error: { code: "not_found", message: "not found" },
    });

    await expect(promise).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "not found" },
    });
  });

  it("sends StatusNotification options on update_connector_status rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const timestamp = new Date("2026-01-02T03:04:05.000Z");
    const promise = service.sendStatusNotification(
      "cp-1",
      1,
      OCPPStatus.Faulted,
      {
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp,
        suppressChargingStateTransactionEvent: true,
      },
    );
    const ack = nextAck();

    expect(ack.request).toEqual({
      cpId: "cp-1",
      method: "update_connector_status",
      params: {
        connector: 1,
        status: "Faulted",
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp: "2026-01-02T03:04:05.000Z",
        suppressChargingStateTransactionEvent: true,
      },
    });

    ack.resolve({ ok: true, result: undefined });
    await expect(promise).resolves.toBeUndefined();
  });

  it("sends CLI OCPP command RPC payloads", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    const diagnostics = service.sendDiagnosticsStatusNotification(
      "cp-1",
      "Uploading",
    );
    const diagnosticsAck = nextAck();
    expect(diagnosticsAck.request).toEqual({
      cpId: "cp-1",
      method: "diagnostics_status_notification",
      params: { status: "Uploading" },
    });
    diagnosticsAck.resolve({ ok: true, result: undefined });
    await expect(diagnostics).resolves.toBeUndefined();

    const firmware = service.sendFirmwareStatusNotification(
      "cp-1",
      "Downloaded",
    );
    const firmwareAck = nextAck();
    expect(firmwareAck.request).toEqual({
      cpId: "cp-1",
      method: "firmware_status_notification",
      params: { status: "Downloaded" },
    });
    firmwareAck.resolve({ ok: true, result: undefined });
    await expect(firmware).resolves.toBeUndefined();

    const security = service.sendSecurityEventNotification(
      "cp-1",
      "SettingSystemTime",
      "clock adjusted",
    );
    const securityAck = nextAck();
    expect(securityAck.request).toEqual({
      cpId: "cp-1",
      method: "security_event_notification",
      params: { type: "SettingSystemTime", techInfo: "clock adjusted" },
    });
    securityAck.resolve({ ok: true, result: undefined });
    await expect(security).resolves.toBeUndefined();

    const sign = service.sendSignCertificate("cp-1", "-----BEGIN CSR-----");
    const signAck = nextAck();
    expect(signAck.request).toEqual({
      cpId: "cp-1",
      method: "sign_certificate",
      params: { csr: "-----BEGIN CSR-----" },
    });
    signAck.resolve({ ok: true, result: undefined });
    await expect(sign).resolves.toBeUndefined();
  });

  it("reads EV and auto-meter settings from the status snapshot", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const evSettings = {
      modelName: "Test EV",
      batteryCapacityKwh: 64,
      maxChargingPowerKw: 90,
      initialSoc: 12,
      targetSoc: 88,
    };
    const autoMeter = autoMeterConfig();

    const evPromise = service.getEVSettings("cp-1", 1);
    const evAck = nextAck();
    expect(evAck.request).toEqual({
      cpId: "cp-1",
      method: "status",
      params: {},
    });
    evAck.resolve({
      ok: true,
      result: {
        ...statusWire("cp-1"),
        connectors: [connectorWire(1, { evSettings })],
      },
    });
    await expect(evPromise).resolves.toEqual(evSettings);

    const autoPromise = service.getAutoMeterValueConfig("cp-1", 1);
    const autoAck = nextAck();
    expect(autoAck.request).toEqual({
      cpId: "cp-1",
      method: "status",
      params: {},
    });
    autoAck.resolve({
      ok: true,
      result: {
        ...statusWire("cp-1"),
        connectors: [
          connectorWire(1, {
            autoMeterValueConfig: autoMeter as unknown as Record<
              string,
              unknown
            >,
          }),
        ],
      },
    });
    await expect(autoPromise).resolves.toEqual(autoMeter);
  });

  it("sends scenario file/template run RPC payloads", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    const fileRun = service.runScenarioFile("cp-1", "/tmp/flow.json", {
      connectorId: 2,
    });
    const fileAck = nextAck();
    expect(fileAck.request).toEqual({
      cpId: "cp-1",
      method: "run_scenario_file",
      params: { connector: 2, file: "/tmp/flow.json" },
    });
    fileAck.resolve({ ok: true, result: { scenarioId: "file-scenario" } });
    await expect(fileRun).resolves.toEqual({ scenarioId: "file-scenario" });

    const templateRun = service.runScenarioTemplate(
      "cp-1",
      "essential-cp-behavior",
      { connectorId: 3, evSettings: { maxChargingPowerKw: 3 } },
    );
    const templateAck = nextAck();
    expect(templateAck.request).toEqual({
      cpId: "cp-1",
      method: "run_scenario_template",
      params: {
        connector: 3,
        templateId: "essential-cp-behavior",
        evSettings: { maxChargingPowerKw: 3 },
      },
    });
    templateAck.resolve({
      ok: true,
      result: { scenarioId: "template-scenario" },
    });
    await expect(templateRun).resolves.toEqual({
      scenarioId: "template-scenario",
    });
  });

  it("requests scenario templates through a cp-less rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.getScenarioTemplates();
    const ack = nextAck();
    const templates = [
      {
        id: "essential-cp-behavior",
        name: "Essential CP Behavior",
        description: "demo template",
      },
    ];

    expect(ack.request).toEqual({
      method: "scenario.templates",
      params: {},
    });

    ack.resolve({ ok: true, result: templates });
    await expect(promise).resolves.toEqual(templates);
  });

  it("loads redacted config through config.get rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.loadConfig();
    const ack = nextAck();
    const config = {
      wsURL: "ws://example.test/ocpp",
      ChargePointID: "cp-1",
      connectorNumber: 1,
      tagID: "TAG-1",
      ocppVersion: "OCPP-1.6J",
      basicAuthSettings: {
        enabled: true,
        username: "user",
      },
      autoMeterValueSetting: {
        enabled: false,
        interval: 30,
        value: 10,
      },
      Experimental: null,
      BootNotification: {
        chargePointVendor: "Vendor",
        chargePointModel: "Model",
      },
    };

    expect(ack.request).toEqual({
      method: "config.get",
      params: {},
    });

    ack.resolve({ ok: true, result: config });
    await expect(promise).resolves.toEqual(config);
    expect("password" in config.basicAuthSettings).toBe(false);
  });

  it("subscribeConfig delivers live redacted updates and stops after unsubscribe", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const configs: Array<WireSimulatorConfig | null> = [];

    const unsubscribe = service.subscribeConfig((config) => {
      configs.push(config);
    });

    const subscribeAck = nextAck();
    expect(subscribeAck.request).toEqual({
      method: "events.subscribe",
      params: { scope: "config" },
    });
    subscribeAck.resolve({ ok: true, result: subscribeResult("config") });
    await flush();
    await flush();

    const initial = wireSimulatorConfig("cp-initial");
    const getAck = nextAck();
    expect(getAck.request).toEqual({
      method: "config.get",
      params: {},
    });
    getAck.resolve({ ok: true, result: initial });
    await flush();
    await flush();

    expect(configs).toEqual([initial]);

    const changed = wireSimulatorConfig("cp-changed", "changed-user");
    latestSocket().serverEvent({
      kind: "config",
      event: "config-changed",
      config: changed,
    });

    expect(configs).toEqual([initial, changed]);
    expect(configs[1]?.basicAuthSettings).toEqual({
      enabled: true,
      username: "changed-user",
    });
    expect("password" in (configs[1]?.basicAuthSettings ?? {})).toBe(false);
    expect(JSON.stringify(configs[1])).not.toContain("secret");

    unsubscribe();
    const unsubscribeAck = nextAck();
    expect(unsubscribeAck.request).toEqual({
      method: "events.unsubscribe",
      params: { scope: "config" },
    });
    unsubscribeAck.resolve({ ok: true, result: { ok: true } });

    latestSocket().serverEvent({
      kind: "config",
      event: "config-changed",
      config: wireSimulatorConfig("cp-ignored"),
    });

    expect(configs).toEqual([initial, changed]);
  });

  it("sends scenario definition persistence rpc payloads", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const first = scenarioDefinition("first");
    const second = scenarioDefinition("second");

    const listPromise = service.listScenarioDefinitions("cp-1", null);
    const listAck = nextAck();
    expect(listAck.request).toEqual({
      method: "scenario.definitions.list",
      params: { cpId: "cp-1", connectorId: null },
    });
    listAck.resolve({ ok: true, result: [first] });
    await expect(listPromise).resolves.toEqual([first]);

    const savePromise = service.saveScenarioDefinition("cp-1", 1, first);
    const saveAck = nextAck();
    expect(saveAck.request).toEqual({
      method: "scenario.definitions.save",
      params: { cpId: "cp-1", connectorId: 1, definition: first },
    });
    saveAck.resolve({ ok: true, result: first });
    await expect(savePromise).resolves.toEqual(first);

    const replacePromise = service.replaceConnectorScenarioDefinitions(
      "cp-1",
      1,
      [first, second],
    );
    const replaceAck = nextAck();
    expect(replaceAck.request).toEqual({
      method: "scenario.definitions.replace",
      params: {
        cpId: "cp-1",
        connectorId: 1,
        definitions: [first, second],
      },
    });
    replaceAck.resolve({ ok: true, result: [first, second] });
    await expect(replacePromise).resolves.toEqual([first, second]);

    const deletePromise = service.deleteScenarioDefinition("cp-1", 1, "first");
    const deleteAck = nextAck();
    expect(deleteAck.request).toEqual({
      method: "scenario.definitions.delete",
      params: { cpId: "cp-1", connectorId: 1, definitionId: "first" },
    });
    deleteAck.resolve({ ok: true, result: { ok: true } });
    await expect(deletePromise).resolves.toBeUndefined();
  });

  it("subscribeScenarioDefinitions delivers filtered live updates and stops after unsubscribe", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const initial = scenarioDefinition("initial");
    const changed = scenarioDefinition("changed");
    const ignored = scenarioDefinition("ignored");
    const updates: ScenarioDefinition[][] = [];

    const unsubscribe = service.subscribeScenarioDefinitions(
      "cp-1",
      1,
      (definitions) => {
        updates.push(definitions);
      },
    );

    const subscribeAck = nextAck();
    expect(subscribeAck.request).toEqual({
      method: "events.subscribe",
      params: { scope: "scenario-definitions" },
    });
    subscribeAck.resolve({
      ok: true,
      result: subscribeResult("scenario-definitions"),
    });
    await flush();
    await flush();

    const listAck = nextAck();
    expect(listAck.request).toEqual({
      method: "scenario.definitions.list",
      params: { cpId: "cp-1", connectorId: 1 },
    });
    listAck.resolve({ ok: true, result: [initial] });
    await flush();
    await flush();

    expect(updates).toEqual([[initial]]);

    latestSocket().serverEvent({
      kind: "scenario-definitions",
      event: "scenario-definitions-changed",
      cpId: "cp-2",
      connectorId: 1,
      definitions: scenarioDefinitionsPayload(ignored),
    });
    latestSocket().serverEvent({
      kind: "scenario-definitions",
      event: "scenario-definitions-changed",
      cpId: "cp-1",
      connectorId: 2,
      definitions: scenarioDefinitionsPayload(ignored),
    });

    expect(updates).toEqual([[initial]]);

    latestSocket().serverEvent({
      kind: "scenario-definitions",
      event: "scenario-definitions-changed",
      cpId: "cp-1",
      connectorId: 1,
      definitions: scenarioDefinitionsPayload(changed),
    });

    expect(updates).toEqual([[initial], [changed]]);

    unsubscribe();
    const unsubscribeAck = nextAck();
    expect(unsubscribeAck.request).toEqual({
      method: "events.unsubscribe",
      params: { scope: "scenario-definitions" },
    });
    unsubscribeAck.resolve({ ok: true, result: { ok: true } });

    latestSocket().serverEvent({
      kind: "scenario-definitions",
      event: "scenario-definitions-changed",
      cpId: "cp-1",
      connectorId: 1,
      definitions: scenarioDefinitionsPayload(ignored),
    });

    expect(updates).toEqual([[initial], [changed]]);
  });

  it("sends connector settings persistence rpc payloads", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const config = autoMeterConfig();

    const autoGetPromise = service.getAutoMeterConfig("cp-1", 1);
    const autoGetAck = nextAck();
    expect(autoGetAck.request).toEqual({
      method: "connector_settings.auto_meter.get",
      params: { cpId: "cp-1", connectorId: 1 },
    });
    autoGetAck.resolve({ ok: true, result: config });
    await expect(autoGetPromise).resolves.toEqual(config);

    const autoSavePromise = service.saveAutoMeterConfig("cp-1", 1, config);
    const autoSaveAck = nextAck();
    expect(autoSaveAck.request).toEqual({
      method: "connector_settings.auto_meter.save",
      params: { cpId: "cp-1", connectorId: 1, config },
    });
    autoSaveAck.resolve({ ok: true, result: { ok: true } });
    await expect(autoSavePromise).resolves.toBeUndefined();

    const socGetPromise = service.getSocMeterSync("cp-1", 1);
    const socGetAck = nextAck();
    expect(socGetAck.request).toEqual({
      method: "connector_settings.soc_meter_sync.get",
      params: { cpId: "cp-1", connectorId: 1 },
    });
    socGetAck.resolve({ ok: true, result: false });
    await expect(socGetPromise).resolves.toBe(false);

    const socSavePromise = service.saveSocMeterSync("cp-1", 1, true);
    const socSaveAck = nextAck();
    expect(socSaveAck.request).toEqual({
      method: "connector_settings.soc_meter_sync.save",
      params: { cpId: "cp-1", connectorId: 1, enabled: true },
    });
    socSaveAck.resolve({ ok: true, result: { ok: true } });
    await expect(socSavePromise).resolves.toBeUndefined();
  });

  it("rejects pending rpc calls on disconnect", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    latestSocket().trigger("disconnect", "transport close");

    await expect(promise).rejects.toMatchObject({
      name: "RpcFailure",
      code: "disconnected",
    });
  });

  it("rejects pending rpc calls on timeout", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    nextAck().reject(new Error("operation has timed out"));

    await expect(promise).rejects.toMatchObject({
      name: "RpcFailure",
      code: "timeout",
    });
  });

  it("applies a subscribe snapshot before queued cp events", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const events: ChargePointEvent[] = [];

    service.subscribe("cp-1", (event) => events.push(event));
    const ack = nextAck();
    expect(ack.request.method).toBe("events.subscribe");

    latestSocket().serverEvent({
      kind: "cp",
      cpId: "cp-1",
      evt: {
        event: "status_change",
        data: { status: "Charging" },
      },
    });
    expect(events).toEqual([]);

    ack.resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();

    expect(events.map((event) => event.type)).toEqual(["status", "status"]);
    expect(events[0]).toEqual({ type: "status", status: "Available" });
    expect(events[1]).toEqual({ type: "status", status: "Charging" });
  });

  it("reconnect resync re-subscribes without cp.list or status rpc calls", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    service.subscribe("cp-1", () => {});
    nextAck().resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();
    latestSocket().acks.splice(0);

    latestSocket().trigger("disconnect", "transport close");
    latestSocket().trigger("connect");
    await flush();

    const resubscribe = nextAck();
    expect(resubscribe.request.method).toBe("events.subscribe");
    resubscribe.resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();

    const methods = latestSocket().acks.map((ack) => ack.request.method);
    expect(["events.subscribe", ...methods]).not.toContain("cp.list");
    expect(["events.subscribe", ...methods]).not.toContain("status");
  });

  it("reset is composed from a disconnect rpc then a connect rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    service.subscribe("cp-1", () => {});
    nextAck().resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();
    latestSocket().acks.splice(0);

    // Auto-resolve every rpc ack across all sockets until reset settles
    // (order-robust against any interleaved reconnect resync).
    let settled = false;
    const promise = service.reset("cp-1").then(() => {
      settled = true;
    });
    for (let i = 0; i < 100 && !settled; i++) {
      await flush();
      for (const sock of socketMockState.sockets) {
        let ack = sock.acks.shift();
        while (ack) {
          ack.resolve({
            ok: true,
            result:
              ack.request.method === "events.subscribe"
                ? subscribeResult("cp-1")
                : undefined,
          });
          ack = sock.acks.shift();
        }
      }
    }
    await promise;
    expect(settled).toBe(true);

    // reset = OCPP-level disconnect then connect (no separate cp.reset).
    const methods = socketMockState.sockets.flatMap((sock) =>
      sock.emitWithAck.mock.calls.map(
        (call) => (call[1] as { method: string }).method,
      ),
    );
    expect(methods).toContain("disconnect");
    expect(methods).toContain("connect");
    expect(methods.indexOf("disconnect")).toBeLessThan(
      methods.lastIndexOf("connect"),
    );
  });

  it("throws Error with server rpc failure message", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    nextAck().resolve({
      ok: false,
      error: { code: "not_found", message: "missing cp" },
    });

    await expect(promise).rejects.toBeInstanceOf(RpcFailure);
    await expect(promise).rejects.toMatchObject({
      code: "not_found",
      message: "missing cp",
    });
  });
});
