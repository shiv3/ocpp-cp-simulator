import { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueSetting } from "../cp/domain/charge-point/ChargePoint";
import type { Database } from "../cp/domain/persistence/Database";
import type {
  BootNotification,
  StatusNotificationOptions,
} from "../cp/domain/types/OcppTypes";
import {
  hasStatusNotificationOptions,
  OCPPStatus,
} from "../cp/domain/types/OcppTypes";
import { OCPP_1_5 } from "../cp/domain/types/OcppVersion";
import { OCPPSoapServer } from "../cp/infrastructure/transport/soap/OCPPSoapServer";
import type {
  CLIOptions,
  ChargePointInitOptions,
  ChargePointStatus,
  ConnectorStatus,
} from "./types";
import { ScenarioExecutor } from "../cp/application/scenario/ScenarioExecutor";
import type { ScenarioEvents } from "../cp/application/scenario/ScenarioTypes";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import { EventEmitter } from "../cp/shared/EventEmitter";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
  StartNodeData,
} from "../cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../cp/application/scenario/ScenarioTypes";
import { SqliteScenarioRepository } from "../cp/domain/persistence/SqliteScenarioRepository";
import { SqliteConnectorRuntimeRepository } from "../cp/domain/persistence/SqliteConnectorRuntimeRepository";
import {
  NoopConnectorRuntimeRepository,
  type ConnectorRuntimeRepository,
  type ScenarioPositionSnapshot,
} from "../cp/domain/persistence/ConnectorRuntimeRepository";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import { getDefaultEVSettings } from "../cp/domain/connector/EVSettings";
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
    }
  | {
      readonly event: "connector_removed";
      readonly data: { readonly connectorId: number };
    }
  | {
      readonly event: "heartbeat";
      readonly data: {
        readonly intervalSeconds: number;
        readonly lastSentAt: string | null;
      };
    };

type EventHandler = (evt: CLIEvent) => void;

export class CLIChargePointService {
  private readonly _chargePoint: ChargePoint;
  private readonly _soapServer: OCPPSoapServer | null;
  private readonly _handlers: Set<EventHandler> = new Set();
  private _unsubscribes: Array<() => void> = [];
  private _connectorUnsubscribes: Array<() => void> = [];
  private readonly _scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  > = new Map();
  private readonly _executors: Map<string, ScenarioExecutor> = new Map();
  private readonly _scenarioRepo: SqliteScenarioRepository;
  private readonly _runtimeRepo: ConnectorRuntimeRepository;
  /**
   * Per-connector scenario execution position that was loaded from the
   * persistence layer during {@link restoreConnectorRuntimeFromDatabase}
   * but hasn't yet been handed to a fresh {@link ScenarioExecutor}.
   * Consumed by {@link runScenario} on the first matching call so the
   * resumed executor picks up at the saved node instead of replaying
   * from `start`. Keyed by connectorId because at restore time we don't
   * yet know which scenarioId the auto-start path will pick.
   */
  private readonly _pendingScenarioResumes: Map<
    number,
    ScenarioPositionSnapshot
  > = new Map();
  /**
   * Tracks which connector each running executor belongs to, so the
   * `node.complete` listener can persist the scenarioPosition for the
   * right connector + clear it when the scenario exits.
   */
  private readonly _executorConnectorIds: Map<string, number> = new Map();
  /**
   * The currently-tracked scenario position for each connector. Updated
   * by the `node.complete` listener attached in {@link runScenario}, read
   * by {@link persistConnectorRuntime} so connector-field-change writes
   * include the latest scenario position in the same row. Cleared by the
   * executor exit listener.
   */
  private readonly _scenarioPositionByConnector: Map<
    number,
    ScenarioPositionSnapshot
  > = new Map();
  // Keep the original init so the web console can prefill the "Edit CP"
  // modal without us having to round-trip the persisted SQL row back into
  // ChargePointInitOptions shape. Exposed via getInit() and the
  // `config` block of getStatus().
  private readonly _init: ChargePointInitOptions;

  constructor(
    init: ChargePointInitOptions,
    /** Shared daemon DB. `null` means run in-memory (no `--state-db`). */
    private readonly database: Database | null = null,
  ) {
    this._init = init;
    this._scenarioRepo = new SqliteScenarioRepository(database);
    this._runtimeRepo = database
      ? new SqliteConnectorRuntimeRepository(database)
      : new NoopConnectorRuntimeRepository();
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

    const ocppVersion = init.ocppVersion ?? "OCPP-1.6J";
    const centralSystemUrl = init.centralSystemUrl ?? init.wsUrl;
    if (ocppVersion === OCPP_1_5 && !init.soapCallbackUrl) {
      throw new Error(
        "OCPP 1.5 SOAP requires soapCallbackUrl (--soap-callback-url)",
      );
    }

    // OCPPWebSocket concatenates wsUrl + cpId, so strip trailing cpId if present.
    // OCPP 1.5 SOAP posts to the CentralSystemService URL exactly as configured.
    const baseUrl =
      ocppVersion === OCPP_1_5
        ? centralSystemUrl
        : buildBaseUrl(init.wsUrl, init.cpId);

    this._chargePoint = new ChargePoint(
      init.cpId,
      bootNotification,
      init.connectors,
      baseUrl,
      init.basicAuth,
      autoMeterValue,
      this.database,
      init.extraWsHeaders ?? {},
      init.extraWsSubprotocols ?? [],
      ocppVersion,
      {
        centralSystemUrl,
        soapCallbackUrl: init.soapCallbackUrl,
        soapPath: init.soapPath,
      },
      init.securityProfile,
      init.authorizationKey,
      init.cpoName,
      init.tls,
    );
    this._soapServer =
      ocppVersion === OCPP_1_5
        ? new OCPPSoapServer({
            cpId: init.cpId,
            applyRemoteReset: (type) =>
              this._chargePoint.applyRemoteReset(type, "ocpp15-soap"),
            isRegisteredOcpp15Soap: () =>
              this._chargePoint.isOcpp15SoapChargePoint() &&
              this._init.ocppVersion === OCPP_1_5 &&
              Boolean(this._init.soapCallbackUrl),
          })
        : null;

    this.attachEventForwarders();
    this.setupMeterValueCallbacks();
  }

  static fromOptions(
    options: CLIOptions,
    database: Database | null = null,
  ): CLIChargePointService {
    if (!options.cpId) {
      throw new Error("cpId is required");
    }
    return new CLIChargePointService(
      {
        cpId: options.cpId,
        wsUrl: options.wsUrl,
        centralSystemUrl: options.wsUrl,
        connectors: options.connectors,
        vendor: options.vendor,
        model: options.model,
        ocppVersion: options.ocppVersion,
        soapCallbackUrl: options.soapCallbackUrl ?? undefined,
        soapPath: options.soapPath,
        basicAuth: options.basicAuth,
        extraWsHeaders: options.extraWsHeaders,
        extraWsSubprotocols: options.extraWsSubprotocols,
        securityProfile: options.securityProfile,
        authorizationKey: options.authorizationKey,
        cpoName: options.cpoName,
        tls: options.tls,
        tlsCaPath: options.tlsCaPath,
        tlsCertPath: options.tlsCertPath,
        tlsKeyPath: options.tlsKeyPath,
      },
      database,
    );
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

  handleSoapChargePointServiceRequest(
    pathCpId: string,
    xml: string,
  ): Response | null {
    return this._soapServer?.handleRequest(pathCpId, xml) ?? null;
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
      heartbeat: {
        intervalSeconds: this._chargePoint.heartbeat.intervalSeconds,
        lastSentAt: this._chargePoint.heartbeat.lastSentAt
          ? this._chargePoint.heartbeat.lastSentAt.toISOString()
          : null,
      },
      config: {
        wsUrl: this._init.wsUrl,
        connectors: this._init.connectors,
        vendor: this._init.vendor,
        model: this._init.model,
        basicAuth: this._init.basicAuth,
        centralSystemUrl: this._init.centralSystemUrl,
        soapCallbackUrl: this._init.soapCallbackUrl,
        soapPath: this._init.soapPath,
        ocppVersion: this._init.ocppVersion ?? "OCPP-1.6J",
        securityProfile: this._init.securityProfile,
        cpoName: this._init.cpoName,
        tlsCaPath: this._init.tlsCaPath,
        tlsCertPath: this._init.tlsCertPath,
        tlsKeyPath: this._init.tlsKeyPath,
        bootNotification: this._init.bootNotification ?? null,
      },
    };
  }

  /** Original init the CP was constructed from. Used by socket.io control
   *  flows to surface current config to the web console's edit modal. */
  getInit(): ChargePointInitOptions {
    return this._init;
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

  sendDiagnosticsStatusNotification(status: string): void {
    this._chargePoint.sendDiagnosticsStatusNotification(
      status as "Idle" | "Uploaded" | "UploadFailed" | "Uploading",
    );
  }

  sendFirmwareStatusNotification(status: string): void {
    this._chargePoint.sendFirmwareStatusNotification(
      status as
        | "Downloaded"
        | "DownloadFailed"
        | "Downloading"
        | "Idle"
        | "InstallationFailed"
        | "Installing"
        | "Installed",
    );
  }

  sendSecurityEventNotification(type: string, techInfo?: string): void {
    this._chargePoint.sendSecurityEventNotification(type, techInfo);
  }

  sendSignCertificate(csr?: string): Promise<void> {
    return this._chargePoint.sendSignCertificate(csr);
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

  updateConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): void {
    if (hasStatusNotificationOptions(opts)) {
      this._chargePoint.sendStatusNotificationRaw(connectorId, status, opts);
      return;
    }
    this._chargePoint.updateConnectorStatus(connectorId, status);
  }

  setEVSettings(connectorId: number, settings: EVSettings): void {
    // Explicit set (#105): marks the connector overridden so a later Default
    // EV Settings propagation doesn't clobber it. See applyDefaultEVSettings
    // for the default-propagation counterpart, which respects this flag.
    const connector = this.requireConnector(connectorId);
    connector.applyEvSettingsOverride(settings);
  }

  getEVSettings(connectorId: number): EVSettings {
    return this.requireConnector(connectorId).evSettings;
  }

  /**
   * Default EV Settings propagation (#105): pushed onto every connector of
   * this CP, but only takes effect on connectors that don't currently have
   * an explicit/scenario override active (see Connector.applyDefaultEvSettings).
   */
  applyDefaultEVSettings(settings: EVSettings): void {
    this._chargePoint.connectors.forEach((connector) => {
      connector.applyDefaultEvSettings(settings);
    });
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

  setConnectorSocMeterSync(connectorId: number, enabled: boolean): void {
    const connector = this.requireConnector(connectorId);
    connector.socMeterSyncEnabled = enabled;
  }

  setConnectorMode(connectorId: number, mode: ScenarioMode): void {
    const connector = this.requireConnector(connectorId);
    connector.mode = mode;
  }

  setConnectorSoc(connectorId: number, soc: number | null): void {
    const connector = this.requireConnector(connectorId);
    if (soc !== null) {
      if (!Number.isFinite(soc) || soc < 0 || soc > 100) {
        throw new Error(`SoC must be between 0 and 100 (got ${soc})`);
      }
    }
    connector.soc = soc;
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

  /**
   * Instantiate the named template once per connector and run it through
   * loadScenario so it gets persisted. Used by CPRegistry.create to seed
   * a fresh CP with the canonical demo flow without each operator having
   * to pick it from the editor's template picker. Silently swallows
   * per-connector failures (e.g. template id changed since release) — a
   * busted seed shouldn't block CP creation.
   */
  seedDefaultScenarios(templateId: string): void {
    for (const connectorId of this._chargePoint.connectors.keys()) {
      try {
        this.loadScenarioTemplate(templateId, connectorId);
      } catch (err) {
        process.stderr.write(
          `[CLI] seedDefaultScenarios(${templateId}) failed for connector ${connectorId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
    }
  }

  loadScenarioTemplate(
    templateId: string,
    connectorId: number,
    evSettingsOverride?: Partial<EVSettings>,
  ): string {
    const template = getTemplateById(templateId);
    if (!template) {
      throw new Error(`Unknown template: ${templateId}`);
    }
    const definition = template.createScenario(
      this._chargePoint.id,
      connectorId,
    );
    // Let callers pin e.g. maxChargingPowerKw without authoring a custom
    // scenario; otherwise the template's own evSettings clobber a prior
    // set_ev_settings when the scenario starts.
    if (evSettingsOverride) {
      definition.evSettings = {
        ...(definition.evSettings ?? getDefaultEVSettings()),
        ...evSettingsOverride,
      };
    }
    return this.loadScenario(connectorId, definition);
  }

  loadScenario(connectorId: number, definition: ScenarioDefinition): string {
    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }
    this._scenarios.set(definition.id, { definition, connectorId });
    // Persist asynchronously — the sql.js writer batches, and a sync
    // failure here would mask a successful in-memory load. `save` on the
    // bun:sqlite path is effectively sync but typed Promise; either way
    // a failure surfaces in stderr and the in-memory copy stays usable.
    void this._scenarioRepo
      .save(this._chargePoint.id, connectorId, definition)
      .catch((err) => {
        process.stderr.write(
          `[CLI] Failed to persist scenario ${definition.id}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      });
    // Scenarios may be loaded after the CP is already connected (e.g. via
    // the JSON `load_scenario` command on a long-running daemon). The CP
    // statusChange event won't refire, so kick the auto-start gate here
    // too — it's idempotent thanks to the dedup key.
    if (this._chargePoint.status === OCPPStatus.Available) {
      this.tryAutoStartForConnector(connectorId, "connect", null);
      this.tryAutoStartForConnector(connectorId, "status", connector.status);
    }
    return definition.id;
  }

  /**
   * Snapshot of every loaded (connectorId, ScenarioDefinition) pair. Used
   * by CPRegistry.update to carry the in-memory scenarios across a
   * cleanup() → new instantiate() rebuild when the daemon is running
   * without --state-db (no `scenarios` table to rehydrate from). The
   * definitions are returned by-reference because they are read-only
   * snapshots of the operator's last load; the new service's
   * loadScenario clones them as needed.
   */
  snapshotScenarios(): ReadonlyArray<{
    readonly connectorId: number;
    readonly definition: ScenarioDefinition;
  }> {
    return Array.from(this._scenarios.values()).map((entry) => ({
      connectorId: entry.connectorId,
      definition: entry.definition,
    }));
  }

  /**
   * Rehydrate all scenarios that were persisted for this CP under the
   * given (cp_id, connector_id) by a previous daemon run. Called from
   * CPRegistry.restoreFromDatabase() after a CP is re-instantiated, so a
   * restart picks up every loaded scenario — and any statusChange-trigger
   * scenarios re-arm automatically via attachStatusChangeAutoTrigger().
   */
  restoreScenariosFromDatabase(): number {
    if (!this.database) return 0;
    let total = 0;
    this._chargePoint.connectors.forEach((_connector, connectorId) => {
      const defs = this._scenarioRepo.listByConnector(
        this._chargePoint.id,
        connectorId,
      );
      for (const def of defs) {
        // Skip already-loaded scenarios so calling this twice is a no-op.
        if (this._scenarios.has(def.id)) continue;
        this._scenarios.set(def.id, { definition: def, connectorId });
        total += 1;
      }
    });
    return total;
  }

  /**
   * Drop a scenario from in-memory state AND the DB. The interface's
   * `delete(cpId, connectorId)` would wipe every scenario on that
   * connector — operators expect to delete just one, so we go through
   * `deleteOne`.
   */
  removeScenario(connectorId: number, scenarioId: string): boolean {
    const entry = this._scenarios.get(scenarioId);
    if (!entry || entry.connectorId !== connectorId) return false;
    const executor = this._executors.get(scenarioId);
    if (executor) {
      executor.stop();
      this._executors.delete(scenarioId);
    }
    this._scenarios.delete(scenarioId);
    this._scenarioRepo.deleteOne(this._chargePoint.id, connectorId, scenarioId);
    return true;
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

    // Build a per-executor event emitter so we can subscribe to
    // `node.complete` and persist the scenario position after every
    // step. Without this, a daemon restart mid-flow can resume the
    // connector_runtime row (Charging, in-flight transaction) but the
    // scenario would replay from `start` and double-fire side-effecting
    // nodes (Plug In, Start Transaction) before reaching `meterValue`.
    const eventEmitter = new EventEmitter<ScenarioEvents>();
    eventEmitter.on(
      "node.complete",
      (data: ScenarioEvents["node.complete"]) => {
        // Push the latest position into the connector-keyed map so any
        // imminent connector-field-change write (status/transaction/…)
        // picks it up. Then trigger a write directly so a daemon kill
        // *right now* still captures the just-finished node.
        const existing = this._scenarioPositionByConnector.get(connectorId);
        const executedNodes = existing
          ? [...existing.executedNodes, data.nodeId]
          : [data.nodeId];
        this._scenarioPositionByConnector.set(connectorId, {
          scenarioKey: scenarioId,
          lastCompletedNodeId: data.nodeId,
          executedNodes,
        });
        this.persistConnectorRuntime(connector, connectorId);
      },
    );

    // Resume hint: if restoreConnectorRuntimeFromDatabase loaded a
    // position for this connector AND the saved node ids still exist in
    // the scenario we're about to run, hand it to the executor's start()
    // so it walks the graph from after lastCompletedNodeId. We can't
    // compare scenarioKey directly: scenario template instances get a
    // fresh `${templateId}-${cpId}-c${connectorId}-${Date.now()}-${suffix}`
    // id on every daemon boot, so the saved key never matches the new
    // run's id. Structural match (lastCompletedNodeId is a node in the
    // current scenario, every executedNode resolves too) is the
    // load-bearing check.
    const pending = this._pendingScenarioResumes.get(connectorId);
    const nodeIds = new Set(entry.definition.nodes.map((n) => n.id));
    const positionMatches =
      pending &&
      pending.lastCompletedNodeId != null &&
      nodeIds.has(pending.lastCompletedNodeId) &&
      pending.executedNodes.every((id) => nodeIds.has(id));
    const resumeOpts = positionMatches
      ? {
          resumeFromNodeId: pending!.lastCompletedNodeId ?? undefined,
          executedNodes: pending!.executedNodes,
        }
      : undefined;
    if (resumeOpts) {
      this._pendingScenarioResumes.delete(connectorId);
      // Rebase the position map to this run's scenarioId so subsequent
      // node.complete writes accumulate against the right key on the
      // next persistConnectorRuntime call.
      this._scenarioPositionByConnector.set(connectorId, {
        ...pending!,
        scenarioKey: scenarioId,
      });
    }

    const executor = new ScenarioExecutor(
      entry.definition,
      callbacks,
      eventEmitter,
    );
    this._executors.set(scenarioId, executor);
    this._executorConnectorIds.set(scenarioId, connectorId);

    this.emit({ event: "scenario_started", data: { connectorId, scenarioId } });

    executor.start(resumeOpts).finally(() => {
      this._executors.delete(scenarioId);
      this._executorConnectorIds.delete(scenarioId);
      // Scenario exited cleanly — clear the persisted position so a
      // subsequent restart treats the connector as idle (the
      // connector_runtime row's transaction_json itself is already
      // null by the time the Stop Transaction node ran).
      this._scenarioPositionByConnector.delete(connectorId);
      // Release the EV settings override (#105): a future Default EV
      // Settings propagation should be free to apply now that this
      // scenario is no longer driving the connector.
      connector.clearEvSettingsOverride();
      this.persistConnectorRuntime(connector, connectorId);
    });
  }

  stepScenario(connectorId: number, scenarioId: string, force = false): void {
    const entry = this._scenarios.get(scenarioId);
    if (!entry) throw new Error(`Scenario ${scenarioId} not found`);
    if (entry.connectorId !== connectorId) {
      throw new Error(
        `Scenario ${scenarioId} is not loaded for connector ${connectorId}`,
      );
    }
    const executor = this._executors.get(scenarioId);
    if (!executor) {
      throw new Error(`Scenario ${scenarioId} is not running`);
    }
    if (force) executor.forceStep();
    else executor.step();
  }

  /**
   * Returns the loaded scenario definition for a given connector + id, or
   * null if the scenario is not loaded on this CP. Used by remote browser
   * clients to see what the daemon has loaded (e.g. via
   * --scenario-template-file).
   */
  getScenario(
    connectorId: number,
    scenarioId: string,
  ): ScenarioDefinition | null {
    const entry = this._scenarios.get(scenarioId);
    if (!entry || entry.connectorId !== connectorId) return null;
    return entry.definition;
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

  stopScenario(connectorId: number, scenarioId: string): void {
    const executor = this._executors.get(scenarioId);
    if (!executor) {
      throw new Error(`Scenario ${scenarioId} is not running`);
    }
    executor.stop();
    this._executors.delete(scenarioId);
    // Release the EV settings override (#105) — see runScenario's
    // executor.start().finally() for the natural-completion counterpart.
    this._chargePoint.connectors.get(connectorId)?.clearEvSettingsOverride();
    // Surface the stop to remote subscribers — executor.stop() bypasses
    // the onStateChange("completed") path used by runScenario(), so the
    // browser's active-scenario tracker would otherwise still believe
    // this scenario is running.
    this.emit({
      event: "scenario_completed",
      data: { connectorId, scenarioId },
    });
  }

  stopAllScenarios(connectorId: number): void {
    for (const [scenarioId, entry] of this._scenarios) {
      if (entry.connectorId === connectorId) {
        const executor = this._executors.get(scenarioId);
        if (executor) {
          executor.stop();
          this._executors.delete(scenarioId);
          // Release the EV settings override (#105), same as stopScenario.
          this._chargePoint.connectors
            .get(connectorId)
            ?.clearEvSettingsOverride();
          this.emit({
            event: "scenario_completed",
            data: { connectorId, scenarioId },
          });
        }
      }
    }
  }

  /** Drain any buffered log lines to the DB — called from the socket.io
   *  logs.get handler so the download includes the last
   *  seconds of activity that the LogRepository hasn't flushed yet. */
  flushLogs(): void {
    this._chargePoint.flushLogs();
  }

  /** In-memory log entries for this CP (Logger's session buffer).
   *  Used by the socket.io logs.get handler when --state-db is off
   *  so the daemon can still serve a useful download. */
  getInMemoryLogs() {
    return this._chargePoint.getInMemoryLogs();
  }

  cleanup(): void {
    for (const executor of this._executors.values()) {
      executor.stop();
    }
    this._executors.clear();
    this._scenarios.clear();
    this._chargePoint.disconnect();
    this.detachConnectorEventForwarders();
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
        // Mirror the browser's "auto-start on connect" gate from
        // src/components/Connector.tsx: when the CP reaches Available
        // (post-BootNotification.Accepted) fire any loaded manual-trigger
        // scenarios whose Start node opts into `triggerOn: "connect"`.
        // Without this, Remote-mode operators have to hit the "Start"
        // button by hand for every scenario — the Connector.tsx auto-start
        // opts out in Remote mode on the assumption the server drives
        // lifecycles, and historically this side only handled the
        // statusChange-trigger case.
        if ((status as OCPPStatus) === OCPPStatus.Available) {
          this.handleConnectAutoStart();
          // Connector statusChange events fired during BootNotification
          // handling race ahead of the CP-level Available transition, so
          // `handleStatusAutoStart` returns early via the
          // `chargePoint.status !== Available` gate and any
          // `triggerOn: "status"` scenario targeting the connector's
          // current state never starts. Re-evaluate every connector here
          // now that the gate is open. Dedup via lastAutoStartedScenarioKey
          // keeps repeats of this branch from re-firing what's already up.
          for (const connector of this._chargePoint.connectors.values()) {
            this.handleStatusAutoStart(
              connector.id,
              connector.status as OCPPStatus,
            );
          }
        }
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
      this._chargePoint.heartbeat.events.on(
        "stateChange",
        ({ intervalSeconds, lastSentAt }) => {
          this.emit({
            event: "heartbeat",
            data: {
              intervalSeconds,
              lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
            },
          });
        },
      ),
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

    this._unsubscribes.push(
      this._chargePoint.events.on("connectorRemoved", ({ connectorId }) => {
        this.emit({ event: "connector_removed", data: { connectorId } });
      }),
    );
  }

  /**
   * Persist the connector's current runtime snapshot to the daemon DB.
   * Called from every event listener that touches a persisted field
   * (status, availability, transaction, meter, soc). No-op when the
   * daemon is running without `--state-db`. Errors are swallowed and
   * logged: a transient SQLite write failure should not crash an
   * in-flight OCPP transaction.
   */
  private persistConnectorRuntime(
    connector: ReturnType<typeof this._chargePoint.connectors.get>,
    connectorId: number,
  ): void {
    if (!connector) return;
    try {
      this._runtimeRepo.save(this._init.cpId, connectorId, {
        ...connector.snapshotRuntime(),
        // Persist whichever scenario position we last captured for this
        // connector, so the row stays a self-consistent snapshot even
        // when the trigger is a connector field change (status/meter/…)
        // rather than a scenario node completion.
        scenarioPosition:
          this._scenarioPositionByConnector.get(connectorId) ?? null,
      });
    } catch (err) {
      console.warn(
        `[service] failed to persist connector_runtime for ` +
          `${this._init.cpId}:${connectorId}`,
        err,
      );
    }
  }

  /**
   * Rehydrate every connector's runtime state from the DB. Called by
   * the CP restore path after `instantiate()` but BEFORE the WebSocket
   * is opened: the snapshot uses
   * {@link Connector.restoreRuntimeSnapshot} which does NOT fire
   * statusChange / meter events, so listeners on the new service won't
   * accidentally push a duplicate StatusNotification to the CSMS the
   * moment we connect.
   *
   * Returns the number of connectors that had a stored snapshot
   * applied (i.e. were not at the default Available / 0 / null state).
   */
  restoreConnectorRuntimeFromDatabase(): number {
    if (!this.database) return 0;
    let restored = 0;
    this._chargePoint.connectors.forEach((connector, connectorId) => {
      const snapshot = this._runtimeRepo.load(this._init.cpId, connectorId);
      if (!snapshot) return;
      connector.restoreRuntimeSnapshot(snapshot);
      // Capture the scenario position so the auto-start path can resume
      // the scenario at the saved node instead of replaying from `start`.
      // Stored on both _pendingScenarioResumes (for runScenario to
      // consume once) and _scenarioPositionByConnector (so the row stays
      // self-consistent on later connector-field-change writes that
      // happen before the executor is re-armed). The same snapshot is
      // intentionally placed in both maps; runScenario removes the
      // pending entry as soon as it hands the position to the executor.
      if (snapshot.scenarioPosition) {
        this._pendingScenarioResumes.set(
          connectorId,
          snapshot.scenarioPosition,
        );
        this._scenarioPositionByConnector.set(
          connectorId,
          snapshot.scenarioPosition,
        );
      }
      restored += 1;
    });
    return restored;
  }

  private attachConnectorEventForwarders(): void {
    this._chargePoint.connectors.forEach((connector, connectorId) => {
      // Runtime persistence: every event that mutates a field in
      // ConnectorRuntimeSnapshot triggers a full snapshot upsert.
      // Snapshots are small (one row, ~10 columns) and writes are
      // throttled naturally by event frequency, so we don't batch.
      const persist = () =>
        this.persistConnectorRuntime(connector, connectorId);
      this._connectorUnsubscribes.push(
        connector.events.on("statusChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("availabilityChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("transactionChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("transactionIdChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("meterValueChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("socChange", persist),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("availabilityChange", ({ availability }) => {
          this.emit({
            event: "connector_availability",
            data: { connectorId, availability },
          });
        }),
      );
      // Manual meter changes and the auto-meter scheduler emit on the
      // connector's event bus rather than the charge-point's. Forward
      // those so remote subscribers see meter updates in real time.
      this._connectorUnsubscribes.push(
        connector.events.on("meterValueChange", ({ meterValue }) => {
          this.emit({
            event: "meter_value",
            data: { connectorId, meterValue },
          });
        }),
      );
      // When the CSMS confirms a StartTransaction, the connector's
      // transactionId switches from the initial placeholder (0) to the real
      // id. Re-emit transaction_started so remote subscribers see the
      // accepted id. Also emit transaction_stopped when it clears (e.g.
      // CSMS-driven stop), so remote clients see the change.
      this._connectorUnsubscribes.push(
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
      this._connectorUnsubscribes.push(
        connector.events.on("socChange", ({ soc }) => {
          this.emit({ event: "connector_soc", data: { connectorId, soc } });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("modeChange", ({ mode }) => {
          this.emit({ event: "connector_mode", data: { connectorId, mode } });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("autoResetToAvailableChange", ({ enabled }) => {
          this.emit({
            event: "connector_auto_reset",
            data: { connectorId, enabled },
          });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("autoMeterValueChange", ({ config }) => {
          this.emit({
            event: "connector_auto_meter",
            data: { connectorId, config },
          });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("evSettingsChange", ({ settings }) => {
          this.emit({
            event: "connector_ev_settings",
            data: { connectorId, settings },
          });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("chargingProfileChange", ({ profile }) => {
          this.emit({
            event: "connector_charging_profile",
            data: { connectorId, profile },
          });
        }),
      );
      this._connectorUnsubscribes.push(
        connector.events.on("chargingProfilesChange", ({ profiles }) => {
          this.emit({
            event: "connector_charging_profiles",
            data: { connectorId, profiles },
          });
        }),
      );

      // statusChange-triggered scenarios: when this connector transitions,
      // scan loaded scenarios for matches and auto-run the first one.
      // Mirrors ScenarioManager.handleStatusChange used by the browser,
      // inlined here to avoid duplicating the (cp, executors) state the
      // service already owns. Also drives the manual-trigger +
      // StartNode.triggerOn === "status" case (mirror of Connector.tsx),
      // since the browser opts out of that path in Remote mode.
      this._connectorUnsubscribes.push(
        connector.events.on("statusChange", ({ status, previousStatus }) => {
          this.handleStatusChangeAutoTrigger(
            connectorId,
            previousStatus as OCPPStatus,
            status as OCPPStatus,
          );
          if ((status as OCPPStatus) !== previousStatus) {
            this.handleStatusAutoStart(connectorId, status as OCPPStatus);
          }
        }),
      );
    });
  }

  /**
   * Mirror of the auto-start useEffect in src/components/Connector.tsx for
   * `triggerOn: "connect"` (the default). Called when the CP reaches
   * Available; runs the first matching loaded scenario per connector.
   */
  private handleConnectAutoStart(): void {
    for (const connector of this._chargePoint.connectors.values()) {
      this.tryAutoStartForConnector(connector.id, "connect", null);
    }
  }

  /**
   * Mirror for `triggerOn: "status"`: fires when the bound connector reaches
   * a specific status (e.g. Charging). Connector statusChange events feed in.
   */
  private handleStatusAutoStart(
    connectorId: number,
    toStatus: OCPPStatus,
  ): void {
    this.tryAutoStartForConnector(connectorId, "status", toStatus);
  }

  /**
   * Shared auto-start engine: walks loaded scenarios for `connectorId`,
   * picks the first manual-trigger scenario whose Start node's `triggerOn`
   * matches `mode` (and `targetStatus` for the "status" case), and runs it
   * via runScenario(). Dedup uses Connector.lastAutoStartedScenarioKey so a
   * status oscillation (or a reconnect that re-fires Available) doesn't
   * restart an already-fired scenario. Matches the browser-side gate
   * exactly.
   */
  private tryAutoStartForConnector(
    connectorId: number,
    mode: "connect" | "status",
    connectorStatus: OCPPStatus | null,
  ): void {
    if (this._chargePoint.status !== OCPPStatus.Available) return;
    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) return;

    for (const [scenarioId, entry] of this._scenarios) {
      if (entry.connectorId !== connectorId) continue;
      const def = entry.definition;
      if (def.enabled === false) {
        connector.lastAutoStartedScenarioKey = null;
        continue;
      }
      // Defensive: a misshapen scenario (wrong JSON shape, half-parsed
      // wire payload, …) shouldn't take down the statusChange listener.
      // Skip silently so other scenarios still get a chance.
      if (!Array.isArray(def.nodes)) {
        process.stderr.write(
          `[CLI] tryAutoStartForConnector: scenario ${scenarioId} has no nodes array; skipping\n`,
        );
        continue;
      }
      // Status-trigger scenarios go through handleStatusChangeAutoTrigger;
      // the browser equally skips them here so they don't double-fire.
      const hasStatusTriggerNode = def.nodes.some(
        (n) => n.type === ScenarioNodeType.STATUS_TRIGGER,
      );
      if (hasStatusTriggerNode) continue;
      // Browser checks `trigger?.type !== "manual"` — i.e. require an
      // explicit "manual" or no trigger at all. `statusChange`-typed
      // triggers are owned by handleStatusChangeAutoTrigger.
      if (def.trigger && def.trigger.type !== "manual") continue;

      const startNode = def.nodes.find(
        (n) => n.type === ScenarioNodeType.START,
      );
      const startData = startNode?.data as StartNodeData | undefined;
      const triggerOn = startData?.triggerOn ?? "connect";
      if (triggerOn !== mode) continue;
      if (mode === "status") {
        const target = startData?.targetStatus;
        if (!target || connectorStatus !== target) continue;
      }

      // Skip if anything is already running for this connector — matches
      // ScenarioManager.handleStatusChange's one-scenario-at-a-time rule.
      let active = false;
      for (const [otherId, otherEntry] of this._scenarios) {
        if (otherEntry.connectorId !== connectorId) continue;
        if (this._executors.has(otherId)) {
          active = true;
          break;
        }
      }
      if (active) return;

      // Dedup key encodes the trigger config + a structural hash of the
      // scenario. Matches Connector.tsx so re-emitting Available (e.g.
      // after a CSMS reconnect) doesn't restart the scenario.
      const structuralKey = JSON.stringify({
        n: def.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
        e: def.edges.map((e) => ({ id: e.id, s: e.source, t: e.target })),
      });
      const autoStartKey = `${def.id}:${structuralKey}:${triggerOn}:${startData?.targetStatus ?? ""}`;
      if (connector.lastAutoStartedScenarioKey === autoStartKey) return;

      try {
        connector.lastAutoStartedScenarioKey = autoStartKey;
        this.runScenario(connectorId, scenarioId);
      } catch (err) {
        connector.lastAutoStartedScenarioKey = null;
        process.stderr.write(
          `[CLI] connect/status auto-start failed for ${scenarioId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
      // One scenario per connector per trigger — matches the browser.
      return;
    }
  }

  /**
   * Inline mirror of ScenarioManager.handleStatusChange — finds the first
   * loaded scenario whose `statusChange` trigger matches the transition
   * and runs it via runScenario(). Skips scenarios that are disabled,
   * already running, or whose ChargePoint isn't `Available` (matches the
   * browser-side guard in ScenarioManager.executeScenario).
   */
  private handleStatusChangeAutoTrigger(
    connectorId: number,
    fromStatus: OCPPStatus,
    toStatus: OCPPStatus,
  ): void {
    if (this._chargePoint.status !== OCPPStatus.Available) return;
    for (const [scenarioId, entry] of this._scenarios) {
      if (entry.connectorId !== connectorId) continue;
      const def = entry.definition;
      if (def.enabled === false) continue;
      const trigger = def.trigger;
      if (!trigger || trigger.type !== "statusChange") continue;
      const cond = trigger.conditions;
      if (cond?.fromStatus && cond.fromStatus !== fromStatus) continue;
      if (cond?.toStatus && cond.toStatus !== toStatus) continue;
      // Don't restart if it's currently running — let it finish first.
      if (this._executors.has(scenarioId)) continue;
      try {
        this.runScenario(connectorId, scenarioId);
      } catch (err) {
        process.stderr.write(
          `[CLI] statusChange auto-trigger failed for ${scenarioId}: ${
            err instanceof Error ? err.message : err
          }\n`,
        );
      }
      // One scenario per status transition — matches ScenarioManager.
      return;
    }
  }

  private detachConnectorEventForwarders(): void {
    for (const unsub of this._connectorUnsubscribes) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this._connectorUnsubscribes = [];
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
