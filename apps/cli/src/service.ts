import type { ResponseOverrideRequest } from "@ocpp-cp-simulator/core/cp/domain/charge-point/responseOverrideRequest";
import type { StartTransactionOutcome } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  Behavior,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import {
  runModemCommand,
  type ModemCommandResult,
  type ModemCommandInput,
} from "@ocpp-cp-simulator/core/cp/domain/modem/index";
import type { CellularPolicySet } from "@ocpp-cp-simulator/core/cp/domain/modem/cellularLink";
import { createChargePoint } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createChargePoint";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import type {
  DataTransferData,
  DataTransferResult,
} from "@ocpp-cp-simulator/core/cp/domain/types/DataTransfer";
import type {
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
  CallResultErrorOutcome,
  CallResultErrorRequest,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppCall";
import type {
  Get15118EVCertificateRequest,
  Get15118EVCertificateResult,
} from "@ocpp-cp-simulator/core/cp/domain/security/get15118EVCertificate";
import type {
  AutoMeterValueSetting,
  PowerLossOptions,
  PowerLossRecord,
  PowerRestoreOptions,
  PowerRestoreResult,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type {
  BootNotification,
  StatusNotificationOptions,
  OCPPStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { hasStatusNotificationOptions } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import {
  readConfigurationKeys,
  writeConfigurationKey,
  type ConfigurationKeyList,
  type ConfigurationSetStatus,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/configurationAccess";
import { configurationWriteCheckV201 } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/v201/setVariablesV201";
import {
  isOcpp2Version,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { soapDialectForVersion } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/soap/dialect";
import { OCPPSoapServer } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/soap/OCPPSoapServer";
import type { ResolvedNetworkSimConfig } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import { getGlobalTraceWriter } from "./trace/TraceWriter";
import {
  splitStopReason,
  type MeterReadingContext,
  type StartTransactionCommandOptions,
  type IdTokenTypeName,
  type StopTransactionCommandOptions,
  type TransactionUpdateOptions,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import { LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { AutoTrafficRunner } from "@ocpp-cp-simulator/core/cp/application/services/AutoTrafficRunner";
import type { AutoTrafficIdTagPicker } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import {
  type AutoTrafficConfig,
  type AutoTrafficCounters,
} from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import { getGlobalMetricsRecorder } from "./server/metrics/MetricsRecorder";
import {
  waitForBootAccepted,
  type WaitForBootAcceptedOptions,
} from "./server/waitForBootAccepted";
import type {
  CLIOptions,
  ChargePointInitOptions,
  ChargePointStatus,
} from "./types";
import type { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import { normalizeLabels } from "@ocpp-cp-simulator/contracts/labels";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionMode,
  ScenarioExecutionState,
  ScenarioMode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { SqliteScenarioRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteScenarioRepository";
import type { ScenarioRepository } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRepository";
import type { PersistedEngineState } from "@ocpp-cp-simulator/core/cp/application/engine/ChargerState";
import { SqliteConnectorRuntimeRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteConnectorRuntimeRepository";
import type { ScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRepository";
import { createScenarioRunRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/createScenarioRunRepository";
import type {
  ChargingSessionPage,
  ChargingSessionQuery,
  ChargingSessionRepository,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import { createChargingSessionRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/createChargingSessionRepository";
import { ChargingSessionRecorder } from "@ocpp-cp-simulator/core/cp/application/services/ChargingSessionRecorder";
import {
  NoopConnectorRuntimeRepository,
  type ConnectorRuntimeRepository,
  type ScenarioPositionSnapshot,
} from "@ocpp-cp-simulator/core/cp/domain/persistence/ConnectorRuntimeRepository";
import type {
  EVSettings,
  EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type {
  StateHistoryEntry,
  HistoryOptions,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type {
  TimelinePage,
  TimelineQuery,
} from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import { appVersion } from "./appVersion";

import type {
  CLIEvent,
  EventHandler,
  SessionSettledHandler,
  SessionSettledInfo,
} from "./service/cliEvents";
import { attachEventForwarders } from "./service/eventForwarders";
import {
  getAutoTrafficConfig,
  getAutoTrafficCounters,
  setAutoTrafficConfig,
  type AutoTrafficHost,
} from "./service/autoTraffic";
import {
  restoreAutoTrafficFromDatabase,
  restoreConnectorRuntimeFromDatabase,
  persistEngineState,
  type RuntimePersistenceHost,
} from "./service/runtimePersistence";
import {
  assertBehaviorsLoadable,
  behaviorIds,
  effectiveBehaviorParams,
  engineStateSnapshot,
  loadBehaviors,
  replaceBehaviors,
  restoreEngineState,
  setBehaviors,
  type BehaviorsHost,
} from "./service/behaviors";
import type { ForwarderHost } from "./service/forwarderHost";
import {
  attachStateHistoryForwarder,
  cleanup,
  persistConnectorRuntime,
  recordScenarioOnTimeline,
  setupMeterValueCallbacks,
  type ServiceLifecycleHost,
} from "./service/serviceLifecycle";
import {
  getStatus,
  onFirmwareVersionChange,
  onSecurityCredentialsChange,
  type CpStatusHost,
} from "./service/cpStatus";
import {
  handleConnectAutoStart,
  handleStatusAutoStart,
  handleStatusChangeAutoTrigger,
  tryAutoStartForConnector,
  type AutoStartHost,
} from "./service/autoStart";
import {
  getScenarioTemplates,
  listScenarios,
  loadScenario,
  loadScenarioTemplate,
  removeScenario,
  restoreScenariosFromDatabase,
  seedDefaultScenarios,
  snapshotScenarios,
  syncConnectorRuntimeScenarios,
  type ScenarioCatalogHost,
} from "./service/scenarioCatalog";
import type { ScenarioTemplateSummary } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import {
  scenarioPositionIsOwnedBy,
  shouldReleaseEvSettingsOverride,
  notifySessionSettled,
  runScenario,
  type ScenarioRunHost,
} from "./service/scenarioRun";
import {
  continueScenarioWait,
  extendScenarioWait,
  getScenario,
  getScenarioReport,
  getScenarioRunResult,
  getScenarioStatus,
  resetScenario,
  retryScenarioWait,
  stepScenario,
  stopAllScenarios,
  stopScenario,
  waitForScenarioArmed,
} from "./service/scenarioControl";

export type { CLIEvent, SessionSettledInfo };
export { scenarioPositionIsOwnedBy, shouldReleaseEvSettingsOverride };

export class CLIChargePointService {
  private readonly _chargePoint: ChargePoint;
  private readonly _soapServer: OCPPSoapServer | null;
  private readonly _handlers: Set<EventHandler> = new Set();
  /**
   * #314: notified once something that can block a reload has *actually*
   * cleared — a scenario run wound up, or a connector's transaction was
   * dropped.
   *
   * Deliberately not `CLIEvent`s. Every lifecycle event on the bus announces
   * the end of a thing from *inside* the code that is ending it, while the
   * state it announces is still set: `scenario_completed` fires from the
   * executor's own state hook with the executor still in `_executors`, and
   * `transaction_stopped` fires from `ChargePoint.stopTransaction` several
   * statements before `connector.stopTransaction()` clears the transaction. A
   * listener that re-checks the gate on those events always finds it shut, and
   * then waits forever for a second notification that never comes. These
   * handlers run after the state is gone, which is the whole point.
   */
  private readonly _sessionSettledHandlers: Set<SessionSettledHandler> =
    new Set();
  private _unsubscribes: Array<() => void> = [];
  private _connectorUnsubscribes: Array<() => void> = [];
  private readonly _scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  > = new Map();
  private readonly _executors: Map<string, ScenarioExecutor> = new Map();
  /**
   * #314: which run currently owns each connector's EV settings override.
   *
   * Keyed by connectorId because the override is a per-connector boolean; the
   * value is the run id (`_runIdByScenario`) of the run that last *applied* EV
   * settings to it. Written only from the `onEvSettingsApplied` hook — never
   * when a definition declaring `evSettings` is merely installed, because a
   * replacement is installed before it runs and may never run at all. Deleted
   * when an operator's `set_ev_settings` takes the override over, and when the
   * owning run releases it.
   *
   * Deliberately here and not on the domain `Connector`:
   * `applyEvSettingsOverride` has callers with no run id at all (the
   * `set_ev_settings` RPC, `LocalChargePointService`, the browser's
   * `ScenarioManager`), and a field they cannot maintain would just go stale.
   * Nor is it persisted: `Connector._evSettingsOverridden` is in-memory only,
   * so after a restart there is no override for an owner to refer to.
   */
  private readonly _evSettingsOwnerByConnector: Map<number, string> = new Map();
  private readonly _autoTraffic = new Map<number, AutoTrafficRunner>();
  private readonly _autoTrafficConfigs = new Map<number, AutoTrafficConfig>();
  /** The idTag stream of each running connector, rebuilt on every
   *  reconfigure so a new strategy, cpIndex or seed takes effect (#603). */
  private readonly _autoTrafficPickers = new Map<
    number,
    AutoTrafficIdTagPicker | null
  >();
  // Resolvers for waitForScenarioArmed(scenarioId), keyed like _executors.
  // Populated only when a caller actually opts in (run_scenario's
  // awaitArmed); resolved and cleared by the onStateChange hook in
  // runScenario the moment the run reaches "waiting" or a terminal state.
  private readonly _armedWaitersByScenario: Map<string, Array<() => void>> =
    new Map();
  // #179: stable per-run id for the currently-executing scenario, so status
  // and lifecycle events can be correlated to a specific run. Keyed like
  // _executors (by scenarioId) and cleared alongside it.
  private readonly _runIdByScenario: Map<string, string> = new Map();
  // #394: transcript capture, assertions, verdict and the stored report of
  // every run, shared with the browser runtime (see ScenarioRunRecorder).
  private _recorderInstance: ScenarioRunRecorder | undefined;
  // Built on first use: it needs the charge point, created further down the
  // constructor than the run history.
  private get _recorder(): ScenarioRunRecorder {
    if (!this._recorderInstance) {
      this._recorderInstance = new ScenarioRunRecorder({
        chargePoint: this._chargePoint,
        runs: this._runs,
        simulatorVersion: appVersion,
        ocppVersion: () => this._init.ocppVersion ?? "OCPP-1.6J",
        // The daemon stamps wall-clock times, whatever the charge point's clock.
        now: () => Date.now(),
        onRecorded: (result) =>
          this.emit({
            event: "scenario_run_recorded",
            data: {
              connectorId: result.connectorId,
              scenarioId: result.scenarioId,
              runId: result.runId,
            },
          }),
      });
    }
    return this._recorderInstance;
  }
  // #388: finished-run reports. The daemon hands every charge point one
  // shared store (see CPRegistry), bounded per charge point and persisted with
  // --state-db; scenario_report reads it, scenario.runs.list pages through it.
  private readonly _runs: ScenarioRunRepository;
  // #447: charging-session history, shared the same way as `_runs`.
  private readonly _sessions: ChargingSessionRepository;
  private readonly _sessionRecorder: ChargingSessionRecorder;
  /**
   * Terminal execution context of the last finished run, per scenarioId.
   *
   * `getScenarioStatus` used to read only `_executors`, which runScenario's
   * finally() deletes from — so status went null the instant a run ended. A
   * client polling for `state === "completed"` never succeeded, and could not
   * distinguish "unknown scenarioId" (still null) from "already finished",
   * even though the run was sitting in the run history the whole time.
   *
   * Entries live until the scenario is removed or its run discarded, and are
   * overwritten by the next run. Bounded by the number of loaded scenarios, so
   * unlike the run history this needs no eviction cap.
   */
  private readonly _lastRunStatusByScenario: Map<
    string,
    ScenarioExecutionContext
  > = new Map();
  private readonly _scenarioRepo: ScenarioRepository;
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
  // Not `readonly`: a `--watch` idTag reload (#314) replaces the block so
  // `getInit().idTags` keeps agreeing with what the charge point is actually
  // drawing from — `cp.update` merges against this, and a stale copy there
  // would quietly re-install the pre-edit pool.
  private _init: ChargePointInitOptions;

  /** What the event forwarders (`service/eventForwarders.ts`) read and call. */
  private readonly _forwarderHost: ForwarderHost = this.createForwarderHost();

  constructor(
    init: ChargePointInitOptions,
    /** Shared daemon DB. `null` means run in-memory (no `--state-db`). */
    private readonly database: Database | null = null,
    /** #388: the daemon-wide run history. Defaults to a store of this
     *  service's own — on `database` when there is one — for the standalone
     *  REPL / JSON-mode runtime. */
    runs?: ScenarioRunRepository,
    /** #447: the daemon-wide session history; defaults like `runs`. */
    sessions?: ChargingSessionRepository,
    /** #495: the daemon-wide scenario definitions; defaults to a store of
     *  this service's own on `database`. */
    scenarios?: ScenarioRepository,
  ) {
    this._init = { ...init, labels: normalizeLabels(init.labels) };
    this._runs = runs ?? createScenarioRunRepository(database);
    this._sessions = sessions ?? createChargingSessionRepository(database);
    this._scenarioRepo = scenarios ?? new SqliteScenarioRepository(database);
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
    if (isSoapVersion(ocppVersion) && !init.soapCallbackUrl) {
      throw new Error(
        "OCPP SOAP versions require a callback URL (--soap-callback-url, or --soap-public-base-url to derive one)",
      );
    }

    // OCPPWebSocket appends the identity to wsUrl, so strip a trailing cpId if present.
    // OCPP SOAP versions post to the CentralSystemService URL exactly as configured.
    const baseUrl = isSoapVersion(ocppVersion)
      ? centralSystemUrl
      : buildBaseUrl(init.wsUrl, init.cpId);

    this._chargePoint = createChargePoint(
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
        // Each supervision URL goes through the same normalisation as the
        // single one: `OCPPWebSocket` appends the cpId, so a URL that already
        // ends in it would otherwise connect to `.../CP001/CP001`.
        ...(init.supervisionUrls && !isSoapVersion(ocppVersion)
          ? {
              supervisionUrls: init.supervisionUrls.map((url) =>
                buildBaseUrl(url, init.cpId),
              ),
            }
          : {}),
        ...(init.urlDistribution
          ? { urlDistribution: init.urlDistribution }
          : {}),
        ...(init.inboundValidation
          ? { inboundValidation: init.inboundValidation }
          : {}),
        ...(init.reservationAuthorizeIdTag
          ? { reservationAuthorizeIdTag: true }
          : {}),
        ...(init.transport?.reconnect
          ? { reconnect: init.transport.reconnect }
          : {}),
        ...(init.capabilityProfile
          ? { capabilityProfile: init.capabilityProfile }
          : {}),
        ...(init.chargerCapabilities
          ? { chargerCapabilities: init.chargerCapabilities }
          : {}),
        ...(init.modem ? { modem: init.modem } : {}),
        ...(init.transport?.ws ? { ws: init.transport.ws } : {}),
        ...(init.idTags ? { idTags: init.idTags } : {}),
        ...(init.idTagDistribution
          ? { idTagDistribution: init.idTagDistribution }
          : {}),
      },
      init.securityProfile,
      init.authorizationKey,
      init.cpoName,
      init.tls,
    );
    this._chargePoint.txUpdatedMeterValues =
      init.txUpdatedMeterValues !== false;
    if (database) this.persistEngineState(database, init.cpId);
    this._soapServer = isSoapVersion(ocppVersion)
      ? new OCPPSoapServer(
          {
            cpId: init.cpId,
            applyRemoteReset: (type) =>
              this._chargePoint.applyRemoteReset(type, "ocpp15-soap"),
            isRegisteredSoapChargePoint: () =>
              this._chargePoint.isSoapChargePoint() &&
              isSoapVersion(this._init.ocppVersion) &&
              Boolean(this._init.soapCallbackUrl),
            chargePoint: this._chargePoint,
            logger: this._chargePoint.logger,
          },
          undefined,
          soapDialectForVersion(ocppVersion),
        )
      : null;

    attachEventForwarders(this._forwarderHost);
    this._sessionRecorder = new ChargingSessionRecorder(
      this._chargePoint,
      this._sessions,
    );
    this._sessionRecorder.onChange((session) =>
      this.emit({ event: "charging_session", data: session }),
    );
    this.setupMeterValueCallbacks();
    // --trace-output (#188): a single wiring point covers standalone,
    // daemon create, daemon restore, and daemon update re-create, since
    // every charge point in every mode is constructed through this
    // constructor (unlike CPRegistry.onRegistryMembership, which the
    // restore/update paths bypass).
    const traceWriter = getGlobalTraceWriter();
    if (traceWriter) {
      this._unsubscribes.push(
        traceWriter.attach({
          cpId: init.cpId,
          ocppVersion: init.ocppVersion,
          logger: this._chargePoint.logger,
        }),
      );
    }
    // Same wiring point, same reason (#298): every charge point in every mode
    // passes through here, so one attach covers standalone, daemon create,
    // daemon restore and daemon update re-create.
    const metricsRecorder = getGlobalMetricsRecorder();
    if (metricsRecorder) {
      this._unsubscribes.push(
        metricsRecorder.attach({
          cpId: init.cpId,
          ocppVersion: init.ocppVersion,
          logger: this._chargePoint.logger,
        }),
      );
    }
  }

  static fromOptions(
    options: CLIOptions,
    database: Database | null = null,
  ): CLIChargePointService {
    if (!options.cpId) {
      throw new Error("cpId is required");
    }
    const service = new CLIChargePointService(
      {
        cpId: options.cpId,
        wsUrl: options.wsUrl,
        centralSystemUrl: options.wsUrl,
        connectors: options.connectors,
        vendor: options.vendor,
        model: options.model,
        ocppVersion: options.ocppVersion,
        soapCallbackUrl: options.soapCallbackUrl ?? undefined,
        // From --soap-public-base-url: same status as a registry-derived URL.
        soapCallbackUrlDerived:
          !options.soapCallbackUrlExplicit && options.soapCallbackUrl != null,
        soapPath: options.soapPath,
        basicAuth: options.basicAuth,
        extraWsHeaders: options.extraWsHeaders,
        extraWsSubprotocols: options.extraWsSubprotocols,
        securityProfile: options.securityProfile,
        authorizationKey: options.authorizationKey,
        cpoName: options.cpoName,
        ...(options.txUpdatedMeterValues !== undefined
          ? { txUpdatedMeterValues: options.txUpdatedMeterValues }
          : {}),
        ...(options.inboundValidation
          ? { inboundValidation: options.inboundValidation }
          : {}),
        ...(options.reservationAuthorizeIdTag
          ? { reservationAuthorizeIdTag: true }
          : {}),
        ...(options.capabilityProfile
          ? { capabilityProfile: options.capabilityProfile }
          : {}),
        ...(options.chargerCapabilities
          ? { chargerCapabilities: options.chargerCapabilities }
          : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        tls: options.tls,
        tlsCaPath: options.tlsCaPath,
        tlsCertPath: options.tlsCertPath,
        tlsKeyPath: options.tlsKeyPath,
      },
      database,
    );
    // The standalone runtime restores no connector runtime: settle now.
    service.reconcileChargingSessions();
    return service;
  }

  onEvent(handler: EventHandler): () => void {
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  /**
   * Subscribe to "a reload gate has actually opened" (#314).
   *
   * Fires from exactly the points where the two things `--watch` defers on stop
   * being true, and always after they have stopped being true:
   *
   * - last in {@link runScenario}'s `finally`, once the executor has been
   *   dropped from `_executors` and the run finalized, so a handler asking
   *   {@link isScenarioRunning} gets `false`;
   * - on a connector's `transactionChange` to null — the one place
   *   `Connector.stopTransaction` clears the transaction — so a handler asking
   *   {@link hasOpenTransaction} gets `false`;
   * - from {@link resetScenario}, which drops the transaction through the
   *   setter and so produces no `transactionChange` of its own.
   */
  onSessionSettled(handler: SessionSettledHandler): () => void {
    this._sessionSettledHandlers.add(handler);
    return () => {
      this._sessionSettledHandlers.delete(handler);
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

  /**
   * See {@link waitForBootAccepted} — exposed here so callers (the CLI
   * startup-scenario path in `startServer.ts`) don't need direct access
   * to the private `_chargePoint`.
   */
  waitForBootAccepted(
    connectorId: number,
    options?: WaitForBootAcceptedOptions,
  ): Promise<boolean> {
    return waitForBootAccepted(this._chargePoint, connectorId, options);
  }

  disconnect(): void {
    this._chargePoint.disconnect();
  }

  async handleSoapChargePointServiceRequest(
    pathCpId: string,
    xml: string,
  ): Promise<Response | null> {
    return (await this._soapServer?.handleRequest(pathCpId, xml)) ?? null;
  }

  getStatus(): ChargePointStatus {
    return getStatus(this.cpStatusHost());
  }

  /**
   * Replace this charge point's labels in place (#446). Labels are metadata
   * the charge point itself never reads, so unlike `CPRegistry.update` this
   * keeps the connection, the transport and every running session.
   */
  setLabels(labels: ChargePointInitOptions["labels"]): void {
    this._init = { ...this._init, labels: normalizeLabels(labels) };
  }

  onSecurityCredentialsChange(
    listener: (change: {
      securityProfile?: 0 | 1 | 2 | 3;
      authorizationKey?: string;
    }) => void,
  ): () => void {
    return onSecurityCredentialsChange(this.cpStatusHost(), listener);
  }

  onFirmwareVersionChange(
    listener: (
      bootNotification: NonNullable<ChargePointInitOptions["bootNotification"]>,
    ) => void,
  ): () => void {
    return onFirmwareVersionChange(this.cpStatusHost(), listener);
  }

  /** A line in this charge point's log, as a transaction message: what an
   *  opt-in `stopTransactions` on `cp.delete` / `disconnect` did. */
  logTransactionNote(message: string): void {
    this._chargePoint.logger.info(message, LogType.TRANSACTION);
  }

  /** Original init the CP was constructed from. Used by socket.io control
   *  flows to surface current config to the web console's edit modal. */
  getInit(): ChargePointInitOptions {
    return this._init;
  }

  /**
   * Install a re-read `idTagPool.file` on the live charge point (#314).
   *
   * Applied immediately, mid-transaction included: the pool is drawn from once
   * per session, so a transaction already under way keeps the tag it presented
   * at StartTransaction and only the next draw sees the new list. Returns
   * `false` when this charge point has no pool to replace.
   */
  /** See {@link ChargePoint.canReplaceIdTags}. */
  canReplaceIdTags(tags: readonly string[]): boolean {
    return this._chargePoint.canReplaceIdTags(tags);
  }

  replaceIdTags(tags: readonly string[]): boolean {
    if (!this._chargePoint.replaceIdTags(tags)) return false;
    this._init = { ...this._init, idTags: [...tags] };
    return true;
  }

  /**
   * Whether a transaction is open on this connector (#314).
   *
   * `transactionId` is 0 between StartTransaction.req and its .conf, so this
   * asks whether the connector holds a transaction at all rather than whether
   * it has a CSMS-assigned id — a reload during that window is still a reload
   * mid-transaction.
   */
  /**
   * Whether connector `connectorId` has a session **running right now**.
   *
   * Deliberately `hasRunningTransaction`, not "a transaction object is
   * attached". The two differ when a closed transaction is still attached:
   * `ChargePoint.cleanTransaction` stamps `stopTime` without detaching it, and
   * until #491 a `StartTransaction` answered with a CALLERROR left it there —
   * as does a `connector_runtime` snapshot persisted then. The connector is
   * logically idle with a transaction still hanging off it, and no further
   * `transactionChange(null)` is emitted for it. Asking the attached-object
   * question made `--watch` hold a reload behind a session that had already
   * failed, with nothing left that could release it (#314).
   *
   * `Connector.hasRunningTransaction` is the codebase's existing definition of
   * the question — `ChargePoint.startTransaction` asks it the same way before
   * refusing a duplicate start — so this reads it rather than restating it.
   */
  hasOpenTransaction(connectorId: number): boolean {
    return (
      this._chargePoint.connectors.get(connectorId)?.hasRunningTransaction ===
      true
    );
  }

  /** Queue the transaction message written but not answered, so the next
   *  start delivers it (#622: the shutdown wait ended first). */
  queueUnansweredStop(): boolean {
    return this._chargePoint.queueUnansweredTransactionCall();
  }

  /** Whether the socket to the CSMS is open right now (#622). */
  isOnline(): boolean {
    return this._chargePoint.isOnline();
  }

  /** Ids of the connectors with a session running right now (#622). */
  openTransactionConnectorIds(): number[] {
    return [...this._chargePoint.connectors.values()]
      .filter((connector) => connector.hasRunningTransaction)
      .map((connector) => connector.id);
  }

  /**
   * The id a stop of the session running on `connectorId` carries on the
   * wire: the 2.x `transactionInfo.transactionId`, or the 1.6 CSMS-assigned
   * `transactionId`. `undefined` when there is no session, or when a 1.6
   * StartTransaction.conf has not assigned the id yet (the stop's id is not
   * known before it is sent). Lets a wait tell its own stops from others.
   */
  transactionWireId(connectorId: number): string | undefined {
    const transaction =
      this._chargePoint.connectors.get(connectorId)?.transaction;
    if (!transaction) return undefined;
    if (transaction.cpTransactionId !== undefined) {
      return transaction.cpTransactionId;
    }
    if (transaction.startUnanswered || transaction.startCallError) {
      return undefined;
    }
    return String(transaction.id);
  }

  /**
   * Subscribe to the frames this charge point writes to and reads from its
   * socket, as the `Sent: <raw>` / `Received: <raw>` lines the logger emits
   * (#622: a graceful shutdown waits for the CSMS to answer the stops).
   * Returns the unsubscribe function.
   */
  onWireFrame(
    handler: (direction: "Sent" | "Received", raw: string) => void,
  ): () => void {
    return this._chargePoint.logger.on("log.WebSocket", (entry) => {
      const match = /^(Sent|Received): (.*)$/s.exec(entry.message);
      if (match) handler(match[1] as "Sent" | "Received", match[2]);
    });
  }

  /** Whether the connector still exists. A reload held for one that has been
   *  removed can never be applied, and nothing else would say so (#314). */
  hasConnector(connectorId: number): boolean {
    return this._chargePoint.connectors.has(connectorId);
  }

  /** Whether a run of this scenario is in flight (#314). */
  isScenarioRunning(scenarioId: string): boolean {
    return this._executors.has(scenarioId);
  }

  setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void {
    this._chargePoint.setNetworkSimConfig(resolved);
  }

  triggerNetworkSimDisconnect(
    ruleId: string,
  ): { ok: true } | { ok: false; error: string } {
    return this._chargePoint.triggerNetworkSimDisconnect(ruleId);
  }

  /** #455: whether the station is without power. */
  get poweredOff(): boolean {
    return this._chargePoint.poweredOff;
  }

  /** #930: install the SIM-scoped policy set (see NetworkSimManager). */
  setCellularPolicies(policies: CellularPolicySet): void {
    this._chargePoint.setCellularPolicies(policies);
  }

  /** #928: the masked modem state, or `null` without a modem model. */
  modemState(): ReturnType<ChargePoint["modemState"]> {
    return this._chargePoint.modemState();
  }

  /** #928: one modem lifecycle command. */
  modemCommand(
    command: ModemCommandInput,
  ): ModemCommandResult<NonNullable<ReturnType<ChargePoint["modemState"]>>> {
    return runModemCommand(this._chargePoint.modem, command, () =>
      this._chargePoint.modemState()!,
    );
  }

  powerLoss(options?: PowerLossOptions): PowerLossRecord {
    return this._chargePoint.powerLoss(options);
  }

  powerRestore(options?: PowerRestoreOptions): PowerRestoreResult {
    return this._chargePoint.restorePower(options);
  }

  reset(): void {
    this._chargePoint.reset();
  }

  isSoapChargePoint(): boolean {
    return this._chargePoint.isSoapChargePoint();
  }

  startTransaction(
    connectorId: number,
    tagId: string,
    options: StartTransactionCommandOptions = {},
  ): Promise<StartTransactionOutcome> {
    return this._chargePoint.startTransaction(
      tagId,
      connectorId,
      undefined,
      undefined,
      options,
    );
  }

  stopTransaction(
    connectorId: number,
    options: StopTransactionCommandOptions = {},
  ): void {
    // #335: one `reason` parameter feeds both encoders — see splitStopReason.
    const { stopReason, stoppedReason } = splitStopReason(options.reason);
    this._chargePoint.stopTransaction(connectorId, stopReason, {
      triggerReason: options.triggerReason,
      stoppedReason,
    });
  }

  /** Drive an OCPP 2.x TransactionEvent(Updated) (#335). */
  sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    this._chargePoint.sendTransactionUpdate(connectorId, options);
  }

  /** #488: an EV-side disconnect on `connectorId`. */
  evDisconnected(connectorId: number): void {
    this._chargePoint.evDisconnected(connectorId);
  }

  /** #453: a cable was plugged into the EV side of `connectorId`. */
  evPlugIn(connectorId: number): void {
    this._chargePoint.evPlugIn(connectorId);
  }

  /** #453: the EV on `connectorId` asks for energy or stops asking. */
  evSetReady(connectorId: number, ready: boolean): void {
    this._chargePoint.evSetReady(connectorId, ready);
  }

  setMeterValue(connectorId: number, value: number): void {
    this._chargePoint.setMeterValue(connectorId, value);
  }

  sendMeterValue(connectorId: number, context?: MeterReadingContext): void {
    this._chargePoint.sendMeterValue(connectorId, context);
  }

  sendHeartbeat(): void {
    this._chargePoint.sendHeartbeat();
  }

  sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void {
    this._chargePoint.sendDiagnosticsStatusNotification(status);
  }

  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this._chargePoint.sendFirmwareStatusNotification(status, requestId);
  }

  /** LogStatusNotification.req (#345): 1.6 Whitepaper / 2.0.1 N01. */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void {
    this._chargePoint.sendLogStatusNotification(status, requestId);
  }

  sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    return this._chargePoint.sendSecurityEventNotification(type, techInfo);
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

  /** {@link ChargePoint.resolveIdTag}, for the daemon's control-plane facade. */
  resolveIdTag(tagId: string | undefined, connectorId?: number): string {
    return this._chargePoint.resolveIdTag(tagId, connectorId);
  }

  authorize(tagId: string, idTokenType?: IdTokenTypeName): void {
    this._chargePoint.authorize(tagId, idTokenType);
  }

  /** Station-initiated DataTransfer.req; resolves with the CSMS's answer (#348). */
  sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: DataTransferData,
  ): Promise<DataTransferResult> {
    return this._chargePoint.sendDataTransfer(vendorId, messageId, data);
  }

  /** Expert OCPP call (#389); see `ChargePoint.sendOcppCall`. */
  sendOcppCall(request: OcppCallRequest): Promise<OcppCallOutcome> {
    return this._chargePoint.sendOcppCall(request);
  }

  /** Expert raw frame (#393); see `ChargePoint.sendRawFrame`. */
  sendRawFrame(request: RawFrameRequest): Promise<RawFrameOutcome> {
    return this._chargePoint.sendRawFrame(request);
  }

  /** Arm a response override (#1090); see `ChargePoint.setResponseOverride`. */
  setResponseOverride(
    request: ResponseOverrideRequest,
  ): Promise<{ action: string; mode: string }> {
    const spec = this._chargePoint.setResponseOverride(request);
    return Promise.resolve({ action: request.action, mode: spec.mode });
  }

  /** Drop armed response overrides (#1090); returns how many. */
  clearResponseOverrides(action?: string): Promise<number> {
    return Promise.resolve(this._chargePoint.clearResponseOverrides(action));
  }

  /** OCPP 2.1 CALLRESULTERROR (#1090); see `ChargePoint.sendCallResultError`. */
  sendCallResultError(
    request: CallResultErrorRequest,
  ): Promise<CallResultErrorOutcome> {
    return this._chargePoint.sendCallResultError(request);
  }

  /** Get15118EVCertificate relay (#537); see
   *  `ChargePoint.get15118EVCertificate`. */
  get15118EVCertificate(
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return this._chargePoint.get15118EVCertificate(request);
  }

  /** #452 test seam: the Authorization Cache and its switch. */
  getAuthorizationCache(): AuthorizationCacheView {
    return this._chargePoint.authorization.cacheView();
  }

  /** #452 test seam; throws InvalidAuthorizationCacheSeedError. */
  seedAuthorizationCache(
    entries: readonly AuthorizationCacheSeedEntry[],
  ): number {
    return this._chargePoint.authorization.seedCache(entries);
  }

  /** #452 test seam: empty the cache whatever its switch says. */
  clearAuthorizationCache(): boolean {
    return this._chargePoint.clearAuthorizationCache();
  }

  updateConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): void {
    const allowInvalidTransition = opts?.allowInvalidTransition === true;
    if (hasStatusNotificationOptions(opts)) {
      // Raw: the connector is not changed, so no transition is checked.
      this._chargePoint.sendStatusNotificationRaw(connectorId, status, opts);
      return;
    }
    if (allowInvalidTransition) {
      this._chargePoint.updateConnectorStatus(connectorId, status, {
        allowInvalidTransition: true,
      });
      return;
    }
    this._chargePoint.updateConnectorStatus(connectorId, status);
  }

  setEVSettings(connectorId: number, settings: EVSettingsPatch): void {
    // Explicit set (#105): marks the connector overridden so a later Default
    // EV Settings propagation doesn't clobber it. See applyDefaultEVSettings
    // for the default-propagation counterpart, which respects this flag.
    const connector = this.requireConnector(connectorId);
    connector.applyEvSettingsOverride(settings);
    // The operator now owns the override, so no run does — including one in
    // flight that claimed it earlier. Without this, that run's completion
    // released a set the operator made during it, which is #105's bug in a
    // new costume (#314).
    this._evSettingsOwnerByConnector.delete(connectorId);
  }

  getEVSettings(connectorId: number): EVSettings {
    return this.requireConnector(connectorId).evSettings;
  }

  /**
   * Default EV Settings propagation (#105): pushed onto every connector of
   * this CP, but only takes effect on connectors that don't currently have
   * an explicit/scenario override active (see Connector.applyDefaultEvSettings).
   */
  applyDefaultEVSettings(settings: EVSettingsPatch): void {
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

  /**
   * Seeded background traffic (#300).
   *
   * Modelled on the auto-meter config above: a per-connector runtime
   * behaviour set by RPC, independent of whether a scenario is loaded. The
   * runner is replaced rather than mutated so the seed takes effect — a
   * reconfigure that kept the old stream would not be reproducible.
   */
  setAutoTrafficConfig(connectorId: number, config: AutoTrafficConfig): void {
    setAutoTrafficConfig(this.autoTrafficHost(), connectorId, config);
  }

  getAutoTrafficConfig(connectorId: number): AutoTrafficConfig {
    return getAutoTrafficConfig(this.autoTrafficHost(), connectorId);
  }

  /** Per-connector counters, the assertion surface for a load run. */
  getAutoTrafficCounters(connectorId: number): AutoTrafficCounters {
    return getAutoTrafficCounters(this.autoTrafficHost(), connectorId);
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

  /** #448: this charge point's operational timeline. */
  getOperationalTimeline(query?: TimelineQuery): TimelinePage {
    return this._chargePoint.timeline.query(query);
  }

  /** #447: this charge point's charging-session history. */
  listChargingSessions(
    query: Omit<ChargingSessionQuery, "cpId"> = {},
  ): ChargingSessionPage {
    return this._sessions.list({ ...query, cpId: this._init.cpId });
  }

  /** #612: this charge point's OCPP configuration keys. */
  getConfigurationKeys(keys: readonly string[] = []): ConfigurationKeyList {
    return readConfigurationKeys(
      this._chargePoint.configuration,
      isOcpp2Version(this._chargePoint.ocppVersion),
      keys,
    );
  }

  /** #612: write one configuration key; see {@link writeConfigurationKey}. */
  setConfigurationKey(key: string, value: string): ConfigurationSetStatus {
    return writeConfigurationKey(
      this._chargePoint.configuration,
      isOcpp2Version(this._chargePoint.ocppVersion),
      key,
      value,
      this._chargePoint.logger,
      isOcpp2Version(this._chargePoint.ocppVersion)
        ? configurationWriteCheckV201(this._chargePoint.ocppVersion)
        : undefined,
    );
  }

  private notifySessionSettled(info: SessionSettledInfo): void {
    return notifySessionSettled(this.scenarioRunHost(), info);
  }

  private requireConnector(connectorId: number) {
    const connector = this._chargePoint.connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }
    return connector;
  }

  getScenarioTemplates(): ReadonlyArray<ScenarioTemplateSummary> {
    return getScenarioTemplates();
  }

  seedDefaultScenarios(templateId: string): void {
    return seedDefaultScenarios(this.scenarioCatalogHost(), templateId);
  }

  loadScenarioTemplate(
    templateId: string,
    connectorId: number,
    evSettingsOverride?: Partial<EVSettings>,
    options: {
      /** Forwarded to {@link loadScenario}: `false` keeps the auto-start gate
       *  out of a "load it and start it now" caller's way (#318). */
      readonly autoStart?: boolean;
      /** `false` loads the instance disabled: the auto-start walker skips it
       *  at every connect, so the only run is the explicit `run_scenario` the
       *  caller makes — a template that runs once, not on every reconnect
       *  (#352). */
      readonly enabled?: boolean;
    } = {},
  ): string {
    return loadScenarioTemplate(
      this.scenarioCatalogHost(),
      templateId,
      connectorId,
      evSettingsOverride,
      options,
    );
  }

  loadScenario(
    connectorId: number,
    definition: ScenarioDefinition,
    options: {
      readonly autoStart?: boolean;
      /**
       * Called once when the durable write for this definition settles: `null`
       * on success, the error on failure. Optional so the synchronous contract
       * is unchanged for callers that do not report an outcome (#314).
       */
      readonly onPersisted?: (error: unknown | null) => void;
    } = {},
  ): string {
    return loadScenario(
      this.scenarioCatalogHost(),
      connectorId,
      definition,
      options,
    );
  }

  snapshotScenarios(): ReadonlyArray<{
    readonly connectorId: number;
    readonly definition: ScenarioDefinition;
  }> {
    return snapshotScenarios(this.scenarioCatalogHost());
  }

  restoreScenariosFromDatabase(): number {
    return restoreScenariosFromDatabase(this.scenarioCatalogHost());
  }

  removeScenario(connectorId: number, scenarioId: string): boolean {
    return removeScenario(this.scenarioCatalogHost(), connectorId, scenarioId);
  }

  syncConnectorRuntimeScenarios(
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): void {
    return syncConnectorRuntimeScenarios(
      this.scenarioCatalogHost(),
      connectorId,
      definitions,
    );
  }

  listScenarios(connectorId: number): ReadonlyArray<{
    readonly scenarioId: string;
    readonly name: string;
    readonly active: boolean;
    readonly state: ScenarioExecutionState | null;
    readonly mode: ScenarioExecutionMode | null;
  }> {
    return listScenarios(this.scenarioCatalogHost(), connectorId);
  }

  runScenario(
    connectorId: number,
    scenarioId: string,
    options?: { strict?: boolean },
  ): void {
    return runScenario(
      this.scenarioRunHost(),
      connectorId,
      scenarioId,
      options,
    );
  }

  waitForScenarioArmed(scenarioId: string, maxWaitMs = 15_000): Promise<void> {
    return waitForScenarioArmed(this.scenarioRunHost(), scenarioId, maxWaitMs);
  }

  stepScenario(connectorId: number, scenarioId: string, force = false): void {
    return stepScenario(this.scenarioRunHost(), connectorId, scenarioId, force);
  }

  extendScenarioWait(
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): void {
    return extendScenarioWait(
      this.scenarioRunHost(),
      connectorId,
      scenarioId,
      seconds,
    );
  }

  retryScenarioWait(connectorId: number, scenarioId: string): void {
    return retryScenarioWait(this.scenarioRunHost(), connectorId, scenarioId);
  }

  continueScenarioWait(connectorId: number, scenarioId: string): void {
    return continueScenarioWait(
      this.scenarioRunHost(),
      connectorId,
      scenarioId,
    );
  }

  getScenario(
    connectorId: number,
    scenarioId: string,
  ): ScenarioDefinition | null {
    return getScenario(this.scenarioRunHost(), connectorId, scenarioId);
  }

  getScenarioStatus(
    _connectorId: number,
    scenarioId: string,
  ): ScenarioExecutionContext | null {
    return getScenarioStatus(this.scenarioRunHost(), _connectorId, scenarioId);
  }

  getScenarioRunResult(
    scenarioId: string,
    runId?: string,
  ): ScenarioRunResult | null {
    return getScenarioRunResult(this.scenarioRunHost(), scenarioId, runId);
  }

  getScenarioReport(
    _connectorId: number,
    scenarioId: string,
    runId?: string,
  ): ScenarioRunResult | null {
    return getScenarioReport(
      this.scenarioRunHost(),
      _connectorId,
      scenarioId,
      runId,
    );
  }

  stopScenario(connectorId: number, scenarioId: string): void {
    return stopScenario(this.scenarioRunHost(), connectorId, scenarioId);
  }

  resetScenario(connectorId: number, scenarioId: string): void {
    return resetScenario(this.scenarioRunHost(), connectorId, scenarioId);
  }

  stopAllScenarios(connectorId: number): void {
    return stopAllScenarios(this.scenarioRunHost(), connectorId);
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

  cleanup(permanent: boolean = false): void {
    return cleanup(this.serviceLifecycleHost(), permanent);
  }

  private scenarioCatalogHost(): ScenarioCatalogHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get database() {
        return self().database;
      },
      get scenarios() {
        return self()._scenarios;
      },
      get executors() {
        return self()._executors;
      },
      get runIdByScenario() {
        return self()._runIdByScenario;
      },
      get lastRunStatusByScenario() {
        return self()._lastRunStatusByScenario;
      },
      get recorder() {
        return self()._recorder;
      },
      get scenarioRepo() {
        return self()._scenarioRepo;
      },
      tryAutoStartForConnector: (connectorId, mode, status) =>
        self().tryAutoStartForConnector(connectorId, mode, status),
      loadScenario: (...args) => self().loadScenario(...args),
      loadScenarioTemplate: (...args) => self().loadScenarioTemplate(...args),
      removeScenario: (...args) => self().removeScenario(...args),
      getScenarioStatus: (...args) => self().getScenarioStatus(...args),
    };
  }

  private scenarioRunHost(): ScenarioRunHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get scenarios() {
        return self()._scenarios;
      },
      get executors() {
        return self()._executors;
      },
      get runIdByScenario() {
        return self()._runIdByScenario;
      },
      get armedWaitersByScenario() {
        return self()._armedWaitersByScenario;
      },
      get scenarioPositionByConnector() {
        return self()._scenarioPositionByConnector;
      },
      get pendingScenarioResumes() {
        return self()._pendingScenarioResumes;
      },
      get executorConnectorIds() {
        return self()._executorConnectorIds;
      },
      get evSettingsOwnerByConnector() {
        return self()._evSettingsOwnerByConnector;
      },
      get lastRunStatusByScenario() {
        return self()._lastRunStatusByScenario;
      },
      get sessionSettledHandlers() {
        return self()._sessionSettledHandlers;
      },
      get recorder() {
        return self()._recorder;
      },
      get runs() {
        return self()._runs;
      },
      emit: (evt) => self().emit(evt),
      persistConnectorRuntime: (connector, connectorId) =>
        self().persistConnectorRuntime(connector, connectorId),
      stopScenario: (...args) => self().stopScenario(...args),
      getScenarioRunResult: (...args) => self().getScenarioRunResult(...args),
    };
  }

  private autoStartHost(): AutoStartHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get executors() {
        return self()._executors;
      },
      get scenarios() {
        return self()._scenarios;
      },
      runScenario: (...args) => self().runScenario(...args),
    };
  }

  private cpStatusHost(): CpStatusHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get init() {
        return self()._init;
      },
      set init(value) {
        self()._init = value;
      },
    };
  }

  private serviceLifecycleHost(): ServiceLifecycleHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get executors() {
        return self()._executors;
      },
      get scenarios() {
        return self()._scenarios;
      },
      get recorder() {
        return self()._recorder;
      },
      get lastRunStatusByScenario() {
        return self()._lastRunStatusByScenario;
      },
      get evSettingsOwnerByConnector() {
        return self()._evSettingsOwnerByConnector;
      },
      get autoTraffic() {
        return self()._autoTraffic;
      },
      get autoTrafficPickers() {
        return self()._autoTrafficPickers;
      },
      get sessionRecorder() {
        return self()._sessionRecorder;
      },
      get handlers() {
        return self()._handlers;
      },
      get sessionSettledHandlers() {
        return self()._sessionSettledHandlers;
      },
      get runtimeRepo() {
        return self()._runtimeRepo;
      },
      get init() {
        return self()._init;
      },
      get scenarioPositionByConnector() {
        return self()._scenarioPositionByConnector;
      },
      get unsubscribes() {
        return self()._unsubscribes;
      },
      set unsubscribes(value) {
        self()._unsubscribes = value;
      },
      get connectorUnsubscribes() {
        return self()._connectorUnsubscribes;
      },
      set connectorUnsubscribes(value) {
        self()._connectorUnsubscribes = value;
      },
      emit: (evt) => self().emit(evt),
    };
  }

  private autoTrafficHost(): AutoTrafficHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get init() {
        return self()._init;
      },
      get autoTraffic() {
        return self()._autoTraffic;
      },
      get autoTrafficConfigs() {
        return self()._autoTrafficConfigs;
      },
      get autoTrafficPickers() {
        return self()._autoTrafficPickers;
      },
      scenarioActive: () => self()._executors.size > 0,
      requireConnector: (connectorId) => self().requireConnector(connectorId),
      stopTransaction: (connectorId) => self().stopTransaction(connectorId),
    };
  }

  private runtimePersistenceHost(): RuntimePersistenceHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get init() {
        return self()._init;
      },
      get database() {
        return self().database;
      },
      get runtimeRepo() {
        return self()._runtimeRepo;
      },
      get pendingScenarioResumes() {
        return self()._pendingScenarioResumes;
      },
      get scenarioPositionByConnector() {
        return self()._scenarioPositionByConnector;
      },
      setAutoTrafficConfig: (connectorId, config) =>
        self().setAutoTrafficConfig(connectorId, config),
    };
  }

  private behaviorsHost(): BehaviorsHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get init() {
        return self()._init;
      },
      set init(value) {
        self()._init = value;
      },
    };
  }

  private createForwarderHost(): ForwarderHost {
    const self = (): CLIChargePointService => this;
    return {
      get chargePoint() {
        return self()._chargePoint;
      },
      get unsubscribes() {
        return self()._unsubscribes;
      },
      get connectorUnsubscribes() {
        return self()._connectorUnsubscribes;
      },
      get init() {
        return self()._init;
      },
      set init(value) {
        self()._init = value;
      },
      get autoTraffic() {
        return self()._autoTraffic;
      },
      emit: (evt) => self().emit(evt),
      notifySessionSettled: (info) => self().notifySessionSettled(info),
      persistConnectorRuntime: (connector, connectorId) =>
        self().persistConnectorRuntime(connector, connectorId),
      handleConnectAutoStart: () => self().handleConnectAutoStart(),
      handleStatusAutoStart: (connectorId, status) =>
        self().handleStatusAutoStart(connectorId, status),
      handleStatusChangeAutoTrigger: (connectorId, from, to) =>
        self().handleStatusChangeAutoTrigger(connectorId, from, to),
      attachStateHistoryForwarder: () => self().attachStateHistoryForwarder(),
    };
  }

  private emit(evt: CLIEvent): void {
    this.recordScenarioOnTimeline(evt);
    for (const handler of this._handlers) {
      try {
        handler(evt);
      } catch (err) {
        process.stderr.write(`[CLI] Event handler error: ${err}\n`);
      }
    }
  }

  private recordScenarioOnTimeline(evt: CLIEvent): void {
    return recordScenarioOnTimeline(this.serviceLifecycleHost(), evt);
  }

  private persistConnectorRuntime(
    connector: ReturnType<typeof this._chargePoint.connectors.get>,
    connectorId: number,
  ): void {
    return persistConnectorRuntime(
      this.serviceLifecycleHost(),
      connector,
      connectorId,
    );
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
  /**
   * Restart background traffic that was configured before the last shutdown
   * (#300).
   *
   * Separate from the runtime snapshot below because the config lives in
   * `connector_settings`, not the connector row. Without this the row survived
   * a restart and the charge point came back idle, with nothing to say the
   * configuration had been dropped — the opposite of what "persisted" means
   * for a feature whose whole job is to keep generating.
   */
  async restoreAutoTrafficFromDatabase(repository: {
    loadAutoTrafficConfig(
      cpId: string,
      connectorId: number,
    ): Promise<AutoTrafficConfig | null>;
  }): Promise<number> {
    return restoreAutoTrafficFromDatabase(
      this.runtimePersistenceHost(),
      repository,
    );
  }

  restoreConnectorRuntimeFromDatabase(): number {
    return restoreConnectorRuntimeFromDatabase(this.runtimePersistenceHost());
  }

  /**
   * Keep the engine's own state (notification statuses, the `ctx.state` of
   * behaviors) in the `engine_state` row. Read back here, in the constructor,
   * so a behavior loaded afterwards adopts its stored `ctx.state` whatever the
   * order of restore and load; the row of a charge point that never existed is
   * absent and reads as the initial state. A stored value this build cannot
   * read is ignored.
   */
  private persistEngineState(database: Database, cpId: string): void {
    persistEngineState(this.runtimePersistenceHost(), database, cpId);
  }

  /**
   * Load behavior code (`--behavior`) onto this charge point. A behavior that
   * cannot load (duplicate id, unmet `requires`) throws; the ones before it
   * stay loaded.
   */
  loadBehaviors(
    behaviors: readonly Behavior[],
    params?: Readonly<Record<string, JsonObject>>,
  ): void {
    loadBehaviors(this.behaviorsHost(), behaviors, params);
  }

  /** The engine state that survives a rebuild (see `ChargerEngine.persistable`). */
  engineStateSnapshot(): PersistedEngineState {
    return engineStateSnapshot(this.behaviorsHost());
  }

  /** Put a {@link engineStateSnapshot} back, before behaviors load. */
  restoreEngineState(saved: PersistedEngineState): void {
    restoreEngineState(this.behaviorsHost(), saved);
  }

  /**
   * The params `ctx.params` hands the behavior with this id now (defaults,
   * the selection's keys, then any running scenario's). Throws for an id that
   * is neither loaded nor built in.
   */
  effectiveBehaviorParams(id: string): JsonObject {
    return effectiveBehaviorParams(this.behaviorsHost(), id);
  }

  /** Ids of the code behaviors loaded on this charge point, in load order. */
  behaviorIds(): string[] {
    return behaviorIds(this.behaviorsHost());
  }

  /**
   * Throws if this station could not load one of `wanted` (the checks a load
   * runs), changing nothing. For a caller that is about to rebuild the station
   * and must find out before it closes the old one.
   */
  assertBehaviorsLoadable(wanted: readonly Behavior[]): void {
    assertBehaviorsLoadable(this.behaviorsHost(), wanted);
  }

  /**
   * Make `wanted` the set of code behaviors running here (a run-time
   * selection): the ones loaded and not wanted are unloaded, the wanted ones
   * not loaded yet are loaded after those already running. `selection` is
   * what is recorded as the charge point's `behaviors` (`undefined`: all).
   */
  setBehaviors(
    wanted: readonly Behavior[],
    selection: readonly string[] | undefined,
    params?: Readonly<Record<string, JsonObject>>,
  ): void {
    setBehaviors(this.behaviorsHost(), wanted, selection, params);
  }

  /**
   * Put new versions of loaded behaviors in their place (a reload), all or
   * none: each is checked before any is replaced, and if one still fails the
   * ones already replaced go back to the version they had.
   */
  replaceBehaviors(next: readonly Behavior[]): void {
    replaceBehaviors(this.behaviorsHost(), next);
  }

  /**
   * Have the loaded behaviors' `onResume` run once the CSMS accepts the next
   * BootNotification. Call it once, after
   * {@link restoreConnectorRuntimeFromDatabase} and
   * {@link reconcileChargingSessions}.
   */
  resumeEngine(): void {
    this._chargePoint.engine.resumeAfterBoot();
  }

  /**
   * #447: settle the sessions a previous instance under this id left open (a
   * `cp.update` rebuild, a restart) against the connectors as they are now.
   * Call it once, after the connector runtime is restored, so a restored
   * transaction keeps its session instead of it being marked interrupted.
   */
  reconcileChargingSessions(): void {
    this._sessionRecorder.reconcile();
  }

  private handleConnectAutoStart(): void {
    return handleConnectAutoStart(this.autoStartHost());
  }

  private handleStatusAutoStart(
    connectorId: number,
    toStatus: OCPPStatus,
  ): void {
    return handleStatusAutoStart(this.autoStartHost(), connectorId, toStatus);
  }

  private tryAutoStartForConnector(
    connectorId: number,
    mode: "connect" | "status",
    connectorStatus: OCPPStatus | null,
  ): void {
    return tryAutoStartForConnector(
      this.autoStartHost(),
      connectorId,
      mode,
      connectorStatus,
    );
  }

  private handleStatusChangeAutoTrigger(
    connectorId: number,
    fromStatus: OCPPStatus,
    toStatus: OCPPStatus,
  ): void {
    return handleStatusChangeAutoTrigger(
      this.autoStartHost(),
      connectorId,
      fromStatus,
      toStatus,
    );
  }

  private attachStateHistoryForwarder(): void {
    return attachStateHistoryForwarder(this.serviceLifecycleHost());
  }

  private setupMeterValueCallbacks(): void {
    return setupMeterValueCallbacks(this.serviceLifecycleHost());
  }
}

/**
 * OCPPWebSocket appends the percent-encoded identity as a path segment when
 * connecting (`wsUrlWithBasic.ts`, OCPP-J 1.6 §3.1.1).
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
