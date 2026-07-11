import * as fs from "fs";

import type { CLIChargePointService } from "./service";
import type {
  ChargePointService,
  ChargePointSnapshot,
  ScenarioTemplateInfo,
} from "../data/interfaces/ChargePointService";
import type { ChargePointStatus } from "./types";
import type { EVSettings } from "../cp/domain/connector/EVSettings";
import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../cp/domain/connector/Connector";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioMode,
} from "../cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "../cp/application/services/types/StateSnapshot";
import type {
  OCPPStatus,
  StatusNotificationOptions,
} from "../cp/domain/types/OcppTypes";

export interface FacadeSingleCpTarget {
  readonly chargePointService: ChargePointService;
  readonly cpId: string;
}

export interface SingleCpRuntimeTarget extends FacadeSingleCpTarget {
  readonly eventSource: Pick<CLIChargePointService, "onEvent">;
  cleanup(): void;
}

export type SingleCpCommandTarget =
  CLIChargePointService | FacadeSingleCpTarget;

export type SingleCpProcessTarget =
  CLIChargePointService | SingleCpRuntimeTarget;

export interface SingleCpCommandOps {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<ChargePointStatus>;
  startTransaction(connectorId: number, tagId: string): Promise<void>;
  stopTransaction(connectorId: number): Promise<void>;
  setMeterValue(connectorId: number, value: number): Promise<void>;
  sendMeterValue(connectorId: number): Promise<void>;
  sendHeartbeat(): Promise<void>;
  startHeartbeat(intervalSeconds: number): Promise<void>;
  stopHeartbeat(): Promise<void>;
  authorize(tagId: string): Promise<void>;
  updateConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    opts?: StatusNotificationOptions,
  ): Promise<void>;
  sendDiagnosticsStatusNotification(status: string): Promise<void>;
  sendFirmwareStatusNotification(status: string): Promise<void>;
  sendSecurityEventNotification(type: string, techInfo?: string): Promise<void>;
  sendSignCertificate(csr?: string): Promise<void>;
  getScenarioTemplates(): Promise<ReadonlyArray<ScenarioTemplateInfo>>;
  loadScenarioTemplate(
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<string>;
  loadScenario(
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<string>;
  listScenarios(connectorId: number): Promise<
    ReadonlyArray<{
      readonly scenarioId: string;
      readonly name: string;
      readonly active: boolean;
    }>
  >;
  runScenario(connectorId: number, scenarioId: string): Promise<void>;
  runScenarioFile(
    connectorId: number,
    filePath: string,
  ): Promise<{ scenarioId: string }>;
  runScenarioTemplate(
    connectorId: number,
    templateId: string,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }>;
  getScenarioStatus(
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null>;
  getScenario(
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null>;
  stopScenario(connectorId: number, scenarioId: string): Promise<void>;
  stepScenario(
    connectorId: number,
    scenarioId: string,
    force?: boolean,
  ): Promise<void>;
  stopAllScenarios(connectorId: number): Promise<void>;
  removeScenario(connectorId: number, scenarioId: string): Promise<boolean>;
  setEVSettings(connectorId: number, settings: EVSettings): Promise<void>;
  getEVSettings(connectorId: number): Promise<EVSettings | null>;
  setAutoMeterValueConfig(
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void>;
  getAutoMeterValueConfig(
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null>;
  setAutoResetToAvailable(connectorId: number, enabled: boolean): Promise<void>;
  setConnectorMode(connectorId: number, mode: ScenarioMode): Promise<void>;
  setConnectorSoc(connectorId: number, soc: number | null): Promise<void>;
  setConnectorSocMeterSync(
    connectorId: number,
    enabled: boolean,
  ): Promise<void>;
  getChargingProfiles(
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>>;
  removeConnector(connectorId: number): Promise<boolean>;
  getStateHistory(options?: HistoryOptions): Promise<StateHistoryEntry[]>;
}

export function getSingleCpCommandOps(
  target: SingleCpCommandTarget,
): SingleCpCommandOps {
  if (isFacadeSingleCpTarget(target)) {
    return facadeCommandOps(target);
  }
  return legacyCommandOps(target);
}

export function getSingleCpEventSource(
  target: SingleCpProcessTarget,
): Pick<CLIChargePointService, "onEvent"> {
  return isSingleCpRuntimeTarget(target) ? target.eventSource : target;
}

export function cleanupSingleCpTarget(target: SingleCpProcessTarget): void {
  if (isSingleCpRuntimeTarget(target)) {
    target.cleanup();
    return;
  }
  target.cleanup();
}

function isSingleCpRuntimeTarget(
  target: SingleCpProcessTarget,
): target is SingleCpRuntimeTarget {
  return (
    isFacadeSingleCpTarget(target) &&
    "eventSource" in target &&
    typeof target.cleanup === "function"
  );
}

function isFacadeSingleCpTarget(
  target: SingleCpCommandTarget,
): target is FacadeSingleCpTarget {
  return (
    typeof target === "object" &&
    target !== null &&
    "chargePointService" in target &&
    "cpId" in target
  );
}

function legacyCommandOps(service: CLIChargePointService): SingleCpCommandOps {
  return {
    connect: () => service.connect(),
    disconnect: async () => {
      service.disconnect();
    },
    getStatus: async () => service.getStatus(),
    startTransaction: async (connectorId, tagId) => {
      service.startTransaction(connectorId, tagId);
    },
    stopTransaction: async (connectorId) => {
      service.stopTransaction(connectorId);
    },
    setMeterValue: async (connectorId, value) => {
      service.setMeterValue(connectorId, value);
    },
    sendMeterValue: async (connectorId) => {
      service.sendMeterValue(connectorId);
    },
    sendHeartbeat: async () => {
      service.sendHeartbeat();
    },
    startHeartbeat: async (intervalSeconds) => {
      service.startHeartbeat(intervalSeconds);
    },
    stopHeartbeat: async () => {
      service.stopHeartbeat();
    },
    authorize: async (tagId) => {
      service.authorize(tagId);
    },
    updateConnectorStatus: async (connectorId, status, opts) => {
      service.updateConnectorStatus(connectorId, status, opts);
    },
    sendDiagnosticsStatusNotification: async (status) => {
      service.sendDiagnosticsStatusNotification(status);
    },
    sendFirmwareStatusNotification: async (status) => {
      service.sendFirmwareStatusNotification(status);
    },
    sendSecurityEventNotification: async (type, techInfo) => {
      service.sendSecurityEventNotification(type, techInfo);
    },
    sendSignCertificate: (csr) => service.sendSignCertificate(csr),
    getScenarioTemplates: async () => service.getScenarioTemplates(),
    loadScenarioTemplate: async (templateId, connectorId, evSettings) =>
      service.loadScenarioTemplate(templateId, connectorId, evSettings),
    loadScenario: async (connectorId, definition) =>
      service.loadScenario(connectorId, definition),
    listScenarios: async (connectorId) => service.listScenarios(connectorId),
    runScenario: async (connectorId, scenarioId) => {
      service.runScenario(connectorId, scenarioId);
    },
    runScenarioFile: async (connectorId, filePath) => {
      const definition = JSON.parse(
        fs.readFileSync(filePath, "utf-8"),
      ) as ScenarioDefinition;
      const scenarioId = service.loadScenario(connectorId, definition);
      service.runScenario(connectorId, scenarioId);
      return { scenarioId };
    },
    runScenarioTemplate: async (connectorId, templateId, evSettings) => {
      const scenarioId = service.loadScenarioTemplate(
        templateId,
        connectorId,
        evSettings,
      );
      service.runScenario(connectorId, scenarioId);
      return { scenarioId };
    },
    getScenarioStatus: async (connectorId, scenarioId) =>
      service.getScenarioStatus(connectorId, scenarioId),
    getScenario: async (connectorId, scenarioId) =>
      service.getScenario(connectorId, scenarioId),
    stopScenario: async (connectorId, scenarioId) => {
      service.stopScenario(connectorId, scenarioId);
    },
    stepScenario: async (connectorId, scenarioId, force) => {
      service.stepScenario(connectorId, scenarioId, force);
    },
    stopAllScenarios: async (connectorId) => {
      service.stopAllScenarios(connectorId);
    },
    removeScenario: async (connectorId, scenarioId) =>
      service.removeScenario(connectorId, scenarioId),
    setEVSettings: async (connectorId, settings) => {
      service.setEVSettings(connectorId, settings);
    },
    getEVSettings: async (connectorId) => service.getEVSettings(connectorId),
    setAutoMeterValueConfig: async (connectorId, config) => {
      service.setAutoMeterValueConfig(connectorId, config);
    },
    getAutoMeterValueConfig: async (connectorId) =>
      service.getAutoMeterValueConfig(connectorId),
    setAutoResetToAvailable: async (connectorId, enabled) => {
      service.setAutoResetToAvailable(connectorId, enabled);
    },
    setConnectorMode: async (connectorId, mode) => {
      service.setConnectorMode(connectorId, mode);
    },
    setConnectorSoc: async (connectorId, soc) => {
      service.setConnectorSoc(connectorId, soc);
    },
    setConnectorSocMeterSync: async (connectorId, enabled) => {
      service.setConnectorSocMeterSync(connectorId, enabled);
    },
    getChargingProfiles: async (connectorId) =>
      service.getChargingProfiles(connectorId),
    removeConnector: async (connectorId) =>
      service.removeConnector(connectorId),
    getStateHistory: async (options) => [...service.getStateHistory(options)],
  };
}

function facadeCommandOps(target: FacadeSingleCpTarget): SingleCpCommandOps {
  const service = target.chargePointService;
  const cpId = target.cpId;

  return {
    connect: () => service.connect(cpId),
    disconnect: () => service.disconnect(cpId),
    getStatus: async () => {
      const snapshot = await service.getChargePoint(cpId);
      if (!snapshot) throw new Error(`cpId not found: ${cpId}`);
      return snapshotToCliStatus(snapshot);
    },
    startTransaction: (connectorId, tagId) =>
      service.startTransaction(cpId, connectorId, tagId),
    stopTransaction: (connectorId) =>
      service.stopTransaction(cpId, connectorId),
    setMeterValue: (connectorId, value) =>
      service.setMeterValue(cpId, connectorId, value),
    sendMeterValue: (connectorId) => service.sendMeterValue(cpId, connectorId),
    sendHeartbeat: () => service.sendHeartbeat(cpId),
    startHeartbeat: (intervalSeconds) =>
      service.startHeartbeat(cpId, intervalSeconds),
    stopHeartbeat: () => service.stopHeartbeat(cpId),
    authorize: (tagId) => service.authorize(cpId, tagId),
    updateConnectorStatus: (connectorId, status, opts) =>
      service.sendStatusNotification(cpId, connectorId, status, opts),
    sendDiagnosticsStatusNotification: (status) =>
      service.sendDiagnosticsStatusNotification(cpId, status),
    sendFirmwareStatusNotification: (status) =>
      service.sendFirmwareStatusNotification(cpId, status),
    sendSecurityEventNotification: (type, techInfo) =>
      service.sendSecurityEventNotification(cpId, type, techInfo),
    sendSignCertificate: (csr) => service.sendSignCertificate(cpId, csr),
    getScenarioTemplates: () => service.getScenarioTemplates(),
    loadScenarioTemplate: async (templateId, connectorId, evSettings) => {
      const result = await service.loadScenarioTemplate(
        cpId,
        templateId,
        connectorId,
        evSettings,
      );
      return result.scenarioId;
    },
    loadScenario: async (connectorId, definition) => {
      const result = await service.loadScenario(cpId, connectorId, definition);
      return result.scenarioId;
    },
    listScenarios: (connectorId) => service.listScenarios(cpId, connectorId),
    runScenario: (connectorId, scenarioId) =>
      service.runScenario(cpId, connectorId, scenarioId),
    runScenarioFile: (connectorId, filePath) =>
      service.runScenarioFile(cpId, filePath, { connectorId }),
    runScenarioTemplate: (connectorId, templateId, evSettings) =>
      service.runScenarioTemplate(cpId, templateId, {
        connectorId,
        evSettings,
      }),
    getScenarioStatus: (connectorId, scenarioId) =>
      service.getScenarioStatus(cpId, connectorId, scenarioId),
    getScenario: (connectorId, scenarioId) =>
      service.getScenario(cpId, connectorId, scenarioId),
    stopScenario: (connectorId, scenarioId) =>
      service.stopScenario(cpId, connectorId, scenarioId),
    stepScenario: (connectorId, scenarioId, force) =>
      service.stepScenario(cpId, connectorId, scenarioId, force),
    stopAllScenarios: (connectorId) =>
      service.stopAllScenarios(cpId, connectorId),
    removeScenario: async (connectorId, scenarioId) => {
      const before = await service.listScenarios(cpId, connectorId);
      await service.removeScenario(cpId, connectorId, scenarioId);
      const after = await service.listScenarios(cpId, connectorId);
      return (
        before.some((scenario) => scenario.scenarioId === scenarioId) &&
        !after.some((scenario) => scenario.scenarioId === scenarioId)
      );
    },
    setEVSettings: (connectorId, settings) =>
      service.setEVSettings(cpId, connectorId, settings),
    getEVSettings: (connectorId) => service.getEVSettings(cpId, connectorId),
    setAutoMeterValueConfig: (connectorId, config) =>
      service.setAutoMeterValueConfig(cpId, connectorId, config),
    getAutoMeterValueConfig: (connectorId) =>
      service.getAutoMeterValueConfig(cpId, connectorId),
    setAutoResetToAvailable: (connectorId, enabled) =>
      service.setAutoResetToAvailable(cpId, connectorId, enabled),
    setConnectorMode: (connectorId, mode) =>
      service.setConnectorMode(cpId, connectorId, mode),
    setConnectorSoc: (connectorId, soc) =>
      service.setConnectorSoc(cpId, connectorId, soc),
    setConnectorSocMeterSync: (connectorId, enabled) =>
      service.setConnectorSocMeterSync(cpId, connectorId, enabled),
    getChargingProfiles: (connectorId) =>
      service.getChargingProfiles(cpId, connectorId),
    removeConnector: async (connectorId) => {
      const before = await service.getChargePoint(cpId);
      await service.removeConnector(cpId, connectorId);
      const after = await service.getChargePoint(cpId);
      return (
        before?.connectors.some((connector) => connector.id === connectorId) ===
          true &&
        after?.connectors.some((connector) => connector.id === connectorId) !==
          true
      );
    },
    getStateHistory: (options) => service.getStateHistory(cpId, options),
  };
}

function snapshotToCliStatus(snapshot: ChargePointSnapshot): ChargePointStatus {
  return {
    id: snapshot.id,
    status: snapshot.status,
    error: snapshot.error,
    connectors: snapshot.connectors.map((connector) => ({
      id: connector.id,
      status: connector.status,
      availability: connector.availability,
      meterValue: connector.meterValue,
      transactionId: connector.transactionId,
      soc: connector.soc,
      mode: connector.mode,
      autoResetToAvailable: connector.autoResetToAvailable,
      autoMeterValueConfig: connector.autoMeterValueConfig as Record<
        string,
        unknown
      > | null,
      evSettings: connector.evSettings as Record<string, unknown> | null,
      chargingProfile: connector.chargingProfile as Record<
        string,
        unknown
      > | null,
      chargingProfiles: connector.chargingProfiles as unknown as ReadonlyArray<
        Record<string, unknown>
      >,
      transactionStartTime: connector.transactionStartTime
        ? connector.transactionStartTime.toISOString()
        : null,
      transactionTagId: connector.transactionTagId,
      transactionBatteryCapacityKwh: connector.transactionBatteryCapacityKwh,
    })),
    heartbeat: snapshot.heartbeat,
    config: snapshot.config
      ? {
          wsUrl: snapshot.config.wsUrl,
          connectors: snapshot.config.connectors,
          vendor: snapshot.config.vendor,
          model: snapshot.config.model,
          basicAuth: snapshot.config.basicAuth,
          centralSystemUrl: snapshot.config.centralSystemUrl,
          soapCallbackUrl: snapshot.config.soapCallbackUrl,
          soapPath: snapshot.config.soapPath,
          securityProfile: snapshot.config.securityProfile,
          cpoName: snapshot.config.cpoName,
          tlsCaPath: snapshot.config.tlsCaPath,
          tlsCertPath: snapshot.config.tlsCertPath,
          tlsKeyPath: snapshot.config.tlsKeyPath,
          ocppVersion: snapshot.config.ocppVersion,
          bootNotification: snapshot.config.bootNotification,
        }
      : undefined,
  };
}
