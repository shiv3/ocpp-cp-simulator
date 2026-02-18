import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueSetting } from "../cp/domain/charge-point/ChargePoint";
import type { BootNotification } from "../cp/domain/types/OcppTypes";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import type { CLIOptions, ChargePointStatus, ConnectorStatus } from "./types";
import { ScenarioExecutor } from "../cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";
import { scenarioTemplates, getTemplateById } from "../utils/scenarioTemplates";

export type CLIEvent =
  | { readonly event: "connected"; readonly data: Record<string, never> }
  | {
      readonly event: "disconnected";
      readonly data: { readonly code: number; readonly reason: string };
    }
  | {
      readonly event: "status_change";
      readonly data: { readonly status: string };
    }
  | { readonly event: "error"; readonly data: { readonly error: string } }
  | {
      readonly event: "connector_status";
      readonly data: {
        readonly connectorId: number;
        readonly status: string;
        readonly previousStatus: string;
      };
    }
  | {
      readonly event: "transaction_started";
      readonly data: {
        readonly connectorId: number;
        readonly transactionId: number;
        readonly tagId: string;
      };
    }
  | {
      readonly event: "transaction_stopped";
      readonly data: {
        readonly connectorId: number;
        readonly transactionId: number;
      };
    }
  | {
      readonly event: "meter_value";
      readonly data: {
        readonly connectorId: number;
        readonly meterValue: number;
      };
    }
  | {
      readonly event: "log";
      readonly data: {
        readonly level: number;
        readonly type: string;
        readonly message: string;
      };
    }
  | {
      readonly event: "scenario_started";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
      };
    }
  | {
      readonly event: "scenario_completed";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
      };
    }
  | {
      readonly event: "scenario_error";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly error: string;
      };
    }
  | {
      readonly event: "scenario_node_execute";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly nodeId: string;
      };
    };

type EventHandler = (evt: CLIEvent) => void;

export class CLIChargePointService {
  private readonly _chargePoint: ChargePoint;
  private readonly _handlers: Set<EventHandler> = new Set();
  private _unsubscribes: Array<() => void> = [];
  private readonly _scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  > = new Map();
  private readonly _executors: Map<string, ScenarioExecutor> = new Map();

  constructor(options: CLIOptions) {
    const bootNotification: BootNotification = {
      chargePointVendor: options.vendor,
      chargePointModel: options.model,
      chargePointSerialNumber: "CLI-001",
      chargeBoxSerialNumber: "CLI-001",
      firmwareVersion: "1.0.0",
      iccid: "",
      imsi: "",
      meterSerialNumber: "CLI-M001",
      meterType: "",
    };

    const autoMeterValue: AutoMeterValueSetting | null = null;

    // OCPPWebSocket concatenates wsUrl + cpId, so strip trailing cpId if present
    const baseUrl = buildBaseUrl(options.wsUrl, options.cpId);

    this._chargePoint = new ChargePoint(
      options.cpId,
      bootNotification,
      options.connectors,
      baseUrl,
      options.basicAuth,
      autoMeterValue,
    );

    this.attachEventForwarders();
    this.setupMeterValueCallbacks();
  }

  onEvent(handler: EventHandler): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubConnect();
        unsubDisconnect();
        reject(new Error("Connection timeout (30s)"));
      }, 30_000);

      const unsubConnect = this._chargePoint.events.once("connected", () => {
        clearTimeout(timeout);
        unsubDisconnect();
        resolve();
      });

      const unsubDisconnect = this._chargePoint.events.once(
        "disconnected",
        ({ code, reason }) => {
          clearTimeout(timeout);
          unsubConnect();
          reject(new Error(`Connection failed: code=${code} reason=${reason}`));
        },
      );

      this._chargePoint.connect();
    });
  }

  disconnect(): void {
    this._chargePoint.disconnect();
  }

  getStatus(): ChargePointStatus {
    const connectors: ConnectorStatus[] = [];
    this._chargePoint.connectors.forEach((connector) => {
      connectors.push({
        id: connector.id,
        status: connector.status,
        availability: connector.availability,
        meterValue: connector.meterValue,
        transactionId: connector.transaction?.id ?? null,
      });
    });

    return {
      id: this._chargePoint.id,
      status: this._chargePoint.status,
      error: this._chargePoint.error,
      connectors,
    };
  }

  startTransaction(connectorId: number, tagId: string): void {
    this._chargePoint.startTransaction(tagId, connectorId);
  }

  stopTransaction(connectorId: number): void {
    this._chargePoint.stopTransaction(connectorId);
  }

  setMeterValue(connectorId: number, value: number): void {
    this._chargePoint.setMeterValue(connectorId, value);
  }

  sendMeterValue(connectorId: number): void {
    this._chargePoint.sendMeterValue(connectorId);
  }

  sendHeartbeat(): void {
    this._chargePoint.sendHeartbeat();
  }

  startHeartbeat(intervalSeconds: number): void {
    this._chargePoint.startHeartbeat(intervalSeconds);
  }

  stopHeartbeat(): void {
    this._chargePoint.stopHeartbeat();
  }

  authorize(tagId: string): void {
    this._chargePoint.authorize(tagId);
  }

  updateConnectorStatus(connectorId: number, status: OCPPStatus): void {
    this._chargePoint.updateConnectorStatus(connectorId, status);
  }

  getScenarioTemplates(): ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }> {
    return scenarioTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }));
  }

  loadScenarioTemplate(templateId: string, connectorId: number): string {
    const template = getTemplateById(templateId);
    if (!template) {
      throw new Error(`Unknown template: ${templateId}`);
    }
    const definition = template.createScenario(
      this._chargePoint.id,
      connectorId,
    );
    return this.loadScenario(connectorId, definition);
  }

  loadScenario(connectorId: number, definition: ScenarioDefinition): string {
    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }
    this._scenarios.set(definition.id, { definition, connectorId });
    return definition.id;
  }

  listScenarios(
    connectorId: number,
  ): ReadonlyArray<{
    readonly scenarioId: string;
    readonly name: string;
    readonly active: boolean;
  }> {
    const result: Array<{
      readonly scenarioId: string;
      readonly name: string;
      readonly active: boolean;
    }> = [];
    for (const [scenarioId, entry] of this._scenarios) {
      if (entry.connectorId === connectorId) {
        result.push({
          scenarioId,
          name: entry.definition.name,
          active: this._executors.has(scenarioId),
        });
      }
    }
    return result;
  }

  runScenario(connectorId: number, scenarioId: string): void {
    const entry = this._scenarios.get(scenarioId);
    if (!entry) {
      throw new Error(`Scenario ${scenarioId} not found`);
    }
    if (entry.connectorId !== connectorId) {
      throw new Error(
        `Scenario ${scenarioId} is not loaded for connector ${connectorId}`,
      );
    }
    if (this._executors.has(scenarioId)) {
      throw new Error(`Scenario ${scenarioId} is already running`);
    }

    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: this._chargePoint,
      connector,
      hooks: {
        onStateChange: (context) => {
          if (context.state === "completed") {
            this.emit({
              event: "scenario_completed",
              data: { connectorId, scenarioId },
            });
          }
        },
        onNodeExecute: (nodeId) => {
          this.emit({
            event: "scenario_node_execute",
            data: { connectorId, scenarioId, nodeId },
          });
        },
        onError: (error) => {
          this.emit({
            event: "scenario_error",
            data: { connectorId, scenarioId, error: error.message },
          });
        },
      },
    });

    const executor = new ScenarioExecutor(entry.definition, callbacks);
    this._executors.set(scenarioId, executor);

    this.emit({ event: "scenario_started", data: { connectorId, scenarioId } });

    executor.start("oneshot").finally(() => {
      this._executors.delete(scenarioId);
    });
  }

  getScenarioStatus(
    _connectorId: number,
    scenarioId: string,
  ): ScenarioExecutionContext | null {
    const executor = this._executors.get(scenarioId);
    if (!executor) {
      return null;
    }
    return executor.getContext();
  }

  stopScenario(_connectorId: number, scenarioId: string): void {
    const executor = this._executors.get(scenarioId);
    if (!executor) {
      throw new Error(`Scenario ${scenarioId} is not running`);
    }
    executor.stop();
    this._executors.delete(scenarioId);
  }

  stopAllScenarios(connectorId: number): void {
    for (const [scenarioId, entry] of this._scenarios) {
      if (entry.connectorId === connectorId) {
        const executor = this._executors.get(scenarioId);
        if (executor) {
          executor.stop();
          this._executors.delete(scenarioId);
        }
      }
    }
  }

  cleanup(): void {
    for (const executor of this._executors.values()) {
      executor.stop();
    }
    this._executors.clear();
    this._scenarios.clear();
    this._chargePoint.disconnect();
    for (const unsub of this._unsubscribes) {
      unsub();
    }
    this._unsubscribes = [];
    this._handlers.clear();
  }

  private emit(evt: CLIEvent): void {
    for (const handler of this._handlers) {
      try {
        handler(evt);
      } catch (err) {
        process.stderr.write(`[CLI] Event handler error: ${err}\n`);
      }
    }
  }

  private attachEventForwarders(): void {
    this._unsubscribes.push(
      this._chargePoint.events.on("statusChange", ({ status }) => {
        this.emit({ event: "status_change", data: { status } });
      }),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on("error", ({ error }) => {
        this.emit({ event: "error", data: { error } });
      }),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on("connected", () => {
        this.emit({ event: "connected", data: {} });
      }),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on("disconnected", ({ code, reason }) => {
        this.emit({ event: "disconnected", data: { code, reason } });
      }),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on(
        "connectorStatusChange",
        ({ connectorId, status, previousStatus }) => {
          this.emit({
            event: "connector_status",
            data: { connectorId, status, previousStatus },
          });
        },
      ),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on(
        "transactionStarted",
        ({ connectorId, transactionId, tagId }) => {
          this.emit({
            event: "transaction_started",
            data: { connectorId, transactionId, tagId },
          });
        },
      ),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on(
        "transactionStopped",
        ({ connectorId, transactionId }) => {
          this.emit({
            event: "transaction_stopped",
            data: { connectorId, transactionId },
          });
        },
      ),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on(
        "connectorMeterValueChange",
        ({ connectorId, meterValue }) => {
          this.emit({
            event: "meter_value",
            data: { connectorId, meterValue },
          });
        },
      ),
    );

    this._unsubscribes.push(
      this._chargePoint.events.on("log", ({ level, type, message }) => {
        this.emit({
          event: "log",
          data: { level, type, message },
        });
      }),
    );
  }

  private setupMeterValueCallbacks(): void {
    this._chargePoint.connectors.forEach((connector) => {
      connector.setOnMeterValueSend((id) => {
        this._chargePoint.sendMeterValue(id);
      });
    });
  }
}

/**
 * OCPPWebSocket concatenates `${wsUrl}${cpId}` when connecting.
 * If the user provides a full URL like `wss://host/chargepoint/CP001`,
 * strip the trailing cpId so it doesn't get doubled.
 * If the URL is already a base URL like `wss://host/chargepoint/`, use as-is.
 */
function buildBaseUrl(wsUrl: string, cpId: string): string {
  if (wsUrl.endsWith(`/${cpId}`)) {
    return wsUrl.slice(0, -cpId.length);
  }
  if (wsUrl.endsWith(`/${cpId}/`)) {
    return wsUrl.slice(0, -(cpId.length + 1)) + "/";
  }
  // Ensure trailing slash so concatenation works: baseUrl + cpId
  return wsUrl.endsWith("/") ? wsUrl : `${wsUrl}/`;
}
