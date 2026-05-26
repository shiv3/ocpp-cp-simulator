import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueSetting } from "../cp/domain/charge-point/ChargePoint";
import type { BootNotification } from "../cp/domain/types/OcppTypes";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import type {
  CLIOptions,
  ChargePointInitOptions,
  ChargePointStatus,
  ConnectorStatus,
} from "./types";
import { ScenarioExecutor } from "../cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../cp/application/scenario/ScenarioTypes";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../cp/domain/connector/Connector";
import type {
  StateHistoryEntry,
  HistoryOptions,
} from "../cp/application/services/types/StateSnapshot";
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
    }
  | {
      readonly event: "connector_availability";
      readonly data: {
        readonly connectorId: number;
        readonly availability: string;
      };
    }
  | {
      readonly event: "connector_soc";
      readonly data: {
        readonly connectorId: number;
        readonly soc: number | null;
      };
    }
  | {
      readonly event: "connector_mode";
      readonly data: { readonly connectorId: number; readonly mode: string };
    }
  | {
      readonly event: "connector_auto_reset";
      readonly data: {
        readonly connectorId: number;
        readonly enabled: boolean;
      };
    }
  | {
      readonly event: "connector_auto_meter";
      readonly data: {
        readonly connectorId: number;
        readonly config: AutoMeterValueConfig;
      };
    }
  | {
      readonly event: "connector_ev_settings";
      readonly data: {
        readonly connectorId: number;
        readonly settings: EVSettings;
      };
    }
  | {
      readonly event: "connector_charging_profile";
      readonly data: {
        readonly connectorId: number;
        readonly profile: ActiveChargingProfile | null;
      };
    }
  | {
      readonly event: "connector_charging_profiles";
      readonly data: {
        readonly connectorId: number;
        readonly profiles: ReadonlyArray<ActiveChargingProfile>;
      };
    }
  | {
      readonly event: "state_history_entry";
      readonly data: { readonly entry: StateHistoryEntry };
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

  constructor(init: ChargePointInitOptions) {
    const overrides = init.bootNotification ?? {};
    const bootNotification: BootNotification = {
      chargePointVendor: init.vendor,
      chargePointModel: init.model,
      chargePointSerialNumber: overrides.chargePointSerialNumber ?? "CLI-001",
      chargeBoxSerialNumber: overrides.chargeBoxSerialNumber ?? "CLI-001",
      firmwareVersion: overrides.firmwareVersion ?? "1.0.0",
      iccid: overrides.iccid ?? "",
      imsi: overrides.imsi ?? "",
      meterSerialNumber: overrides.meterSerialNumber ?? "CLI-M001",
      meterType: overrides.meterType ?? "",
    };

    const autoMeterValue: AutoMeterValueSetting | null = null;

    // OCPPWebSocket concatenates wsUrl + cpId, so strip trailing cpId if present
    const baseUrl = buildBaseUrl(init.wsUrl, init.cpId);

    this._chargePoint = new ChargePoint(
      init.cpId,
      bootNotification,
      init.connectors,
      baseUrl,
      init.basicAuth,
      autoMeterValue,
    );

    this.attachEventForwarders();
    this.setupMeterValueCallbacks();
  }

  static fromOptions(options: CLIOptions): CLIChargePointService {
    if (!options.cpId) {
      throw new Error("cpId is required");
    }
    return new CLIChargePointService({
      cpId: options.cpId,
      wsUrl: options.wsUrl,
      connectors: options.connectors,
      vendor: options.vendor,
      model: options.model,
      basicAuth: options.basicAuth,
    });
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
      const tx = connector.transaction;
      connectors.push({
        id: connector.id,
        status: connector.status,
        availability: connector.availability,
        meterValue: connector.meterValue,
        transactionId: tx?.id ?? null,
        soc: connector.soc,
        mode: connector.mode,
        autoResetToAvailable: connector.autoResetToAvailable,
        autoMeterValueConfig:
          connector.autoMeterValueConfig as unknown as Record<string, unknown>,
        evSettings: connector.evSettings as unknown as Record<string, unknown>,
        chargingProfile:
          (connector.chargingProfile as unknown as Record<string, unknown>) ??
          null,
        chargingProfiles:
          connector.chargingProfiles as unknown as ReadonlyArray<
            Record<string, unknown>
          >,
        transactionStartTime: tx?.startTime ? tx.startTime.toISOString() : null,
        transactionTagId: tx?.tagId ?? null,
        transactionBatteryCapacityKwh: tx?.batteryCapacityKwh ?? null,
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

  setEVSettings(connectorId: number, settings: EVSettings): void {
    const connector = this.requireConnector(connectorId);
    connector.evSettings = settings;
  }

  getEVSettings(connectorId: number): EVSettings {
    return this.requireConnector(connectorId).evSettings;
  }

  setAutoMeterValueConfig(
    connectorId: number,
    config: AutoMeterValueConfig,
  ): void {
    const connector = this.requireConnector(connectorId);
    connector.autoMeterValueConfig = config;
  }

  getAutoMeterValueConfig(connectorId: number): AutoMeterValueConfig {
    return this.requireConnector(connectorId).autoMeterValueConfig;
  }

  setAutoResetToAvailable(connectorId: number, enabled: boolean): void {
    const connector = this.requireConnector(connectorId);
    connector.autoResetToAvailable = enabled;
  }

  setConnectorMode(connectorId: number, mode: ScenarioMode): void {
    const connector = this.requireConnector(connectorId);
    connector.mode = mode;
  }

  getChargingProfiles(
    connectorId: number,
  ): ReadonlyArray<ActiveChargingProfile> {
    return this.requireConnector(connectorId).chargingProfiles;
  }

  removeConnector(connectorId: number): boolean {
    return this._chargePoint.removeConnector(connectorId);
  }

  getStateHistory(options?: HistoryOptions): ReadonlyArray<StateHistoryEntry> {
    return this._chargePoint.stateManager.history.getHistory(options);
  }

  private requireConnector(connectorId: number) {
    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }
    return connector;
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

  listScenarios(connectorId: number): ReadonlyArray<{
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

    this.attachConnectorEventForwarders();
    this.attachStateHistoryForwarder();
  }

  private attachConnectorEventForwarders(): void {
    this._chargePoint.connectors.forEach((connector, connectorId) => {
      this._unsubscribes.push(
        connector.events.on("availabilityChange", ({ availability }) => {
          this.emit({
            event: "connector_availability",
            data: { connectorId, availability },
          });
        }),
      );
      // When the CSMS confirms a StartTransaction, the connector's
      // transactionId switches from the initial placeholder (0) to the real
      // id. Re-emit transaction_started so remote subscribers see the
      // accepted id. Also emit transaction_stopped when it clears (e.g.
      // CSMS-driven stop), so remote clients see the change.
      this._unsubscribes.push(
        connector.events.on("transactionIdChange", ({ transactionId }) => {
          if (transactionId == null) {
            this.emit({
              event: "transaction_stopped",
              data: { connectorId, transactionId: 0 },
            });
            return;
          }
          if (transactionId === 0) return; // placeholder, already emitted on start
          const tagId = connector.transaction?.tagId ?? "";
          this.emit({
            event: "transaction_started",
            data: { connectorId, transactionId, tagId },
          });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("socChange", ({ soc }) => {
          this.emit({ event: "connector_soc", data: { connectorId, soc } });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("modeChange", ({ mode }) => {
          this.emit({ event: "connector_mode", data: { connectorId, mode } });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("autoResetToAvailableChange", ({ enabled }) => {
          this.emit({
            event: "connector_auto_reset",
            data: { connectorId, enabled },
          });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("autoMeterValueChange", ({ config }) => {
          this.emit({
            event: "connector_auto_meter",
            data: { connectorId, config },
          });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("evSettingsChange", ({ settings }) => {
          this.emit({
            event: "connector_ev_settings",
            data: { connectorId, settings },
          });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("chargingProfileChange", ({ profile }) => {
          this.emit({
            event: "connector_charging_profile",
            data: { connectorId, profile },
          });
        }),
      );
      this._unsubscribes.push(
        connector.events.on("chargingProfilesChange", ({ profiles }) => {
          this.emit({
            event: "connector_charging_profiles",
            data: { connectorId, profiles },
          });
        }),
      );
    });
  }

  private attachStateHistoryForwarder(): void {
    const history = this._chargePoint.stateManager.history;
    // StateHistory emits an "entry" event whenever a transition is recorded.
    // Fall back to no-op if the underlying impl doesn't expose subscribe.
    const subscribe = (
      history as unknown as {
        subscribe?: (cb: (entry: StateHistoryEntry) => void) => () => void;
      }
    ).subscribe;
    if (typeof subscribe === "function") {
      this._unsubscribes.push(
        subscribe.call(history, (entry: StateHistoryEntry) => {
          this.emit({ event: "state_history_entry", data: { entry } });
        }),
      );
    }
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
