import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueSetting } from "../../cp/domain/charge-point/ChargePoint";
import { BootNotification, OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type {
  ChargePointEvent,
  ChargePointService,
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../interfaces/ChargePointService";
import { loadConnectorAutoMeterConfig } from "../../utils/connectorStorage";
import type { LogEntry } from "../../cp/shared/Logger";
import { LogLevel, LogType } from "../../cp/shared/Logger";

function toConnectorSnapshot(connector: ReturnType<ChargePoint["getConnector"]>): ConnectorSnapshot | null {
  if (!connector) return null;
  return {
    id: connector.id,
    status: connector.status as OCPPStatus,
    availability: connector.availability,
    meterValue: connector.meterValue,
    transactionId: connector.transaction?.id ?? null,
  };
}

function toChargePointSnapshot(cp: ChargePoint): ChargePointSnapshot {
  const connectors: ConnectorSnapshot[] = [];
  cp.connectors.forEach((connector) => {
    const snapshot = toConnectorSnapshot(connector);
    if (snapshot) connectors.push(snapshot);
  });

  return {
    id: cp.id,
    status: cp.status,
    error: cp.error,
    connectors,
  };
}

export interface LocalChargePointDefinition {
  id: string;
  connectorNumber: number;
  bootNotification: BootNotification;
  wsUrl: string;
  basicAuth: { username: string; password: string } | null;
  autoMeterValueSetting: AutoMeterValueSetting | null;
}

export class LocalChargePointService implements ChargePointService {
  private readonly chargePoints = new Map<string, ChargePoint>();
  private readonly listeners = new Map<string, Set<(event: ChargePointEvent) => void>>();
  private readonly eventSubscriptions = new Map<string, Array<() => void>>();

  registerChargePoint(chargePoint: ChargePoint): void {
    if (this.chargePoints.has(chargePoint.id)) {
      this.unregisterChargePoint(chargePoint.id);
    }

    this.chargePoints.set(chargePoint.id, chargePoint);
    this.attachEventForwarders(chargePoint);
  }

  unregisterChargePoint(id: string): void {
    const cp = this.chargePoints.get(id);
    if (cp) {
      cp.disconnect();
    }
    this.chargePoints.delete(id);

    const subs = this.eventSubscriptions.get(id);
    if (subs) {
      subs.forEach((unsubscribe) => {
        try {
          unsubscribe();
        } catch (error) {
          console.error(`[LocalChargePointService] Failed to unsubscribe listener for ${id}`, error);
        }
      });
      this.eventSubscriptions.delete(id);
    }

    this.listeners.delete(id);
  }

  listChargePoints(): Promise<ChargePointSnapshot[]> {
    const snapshots = Array.from(this.chargePoints.values()).map((cp) =>
      toChargePointSnapshot(cp),
    );
    return Promise.resolve(snapshots);
  }

  getChargePoint(id: string): Promise<ChargePointSnapshot | null> {
    const cp = this.chargePoints.get(id);
    return Promise.resolve(cp ? toChargePointSnapshot(cp) : null);
  }

  getChargePointHandle(id: string): ChargePoint | null {
    return this.chargePoints.get(id) ?? null;
  }

  async connect(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).connect();
  }

  async disconnect(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).disconnect();
  }

  async reset(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).reset();
  }

  async sendHeartbeat(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendHeartbeat();
  }

  async startHeartbeat(id: string, intervalSeconds: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).startHeartbeat(intervalSeconds);
  }

  async stopHeartbeat(id: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).stopHeartbeat();
  }

  async authorize(id: string, tagId: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).authorize(tagId);
  }

  async startTransaction(id: string, connectorId: number, tagId: string): Promise<void> {
    this.getExistingChargePointOrThrow(id).startTransaction(tagId, connectorId);
  }

  async stopTransaction(id: string, connectorId: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).stopTransaction(connectorId);
  }

  async sendStatusNotification(id: string, connectorId: number, status: OCPPStatus): Promise<void> {
    this.getExistingChargePointOrThrow(id).updateConnectorStatus(connectorId, status);
  }

  async setMeterValue(id: string, connectorId: number, value: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).setMeterValue(connectorId, value);
  }

  async sendMeterValue(id: string, connectorId: number): Promise<void> {
    this.getExistingChargePointOrThrow(id).sendMeterValue(connectorId);
  }

  subscribe(id: string, handler: (event: ChargePointEvent) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(handler);
    this.listeners.set(id, listeners);

    const cp = this.chargePoints.get(id);
    if (cp) {
      handler({ type: "status", status: cp.status });
      if (cp.error) {
        handler({ type: "error", error: cp.error });
      }
    }

    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  private getExistingChargePointOrThrow(id: string): ChargePoint {
    const cp = this.chargePoints.get(id);
    if (!cp) {
      throw new Error(`ChargePoint ${id} not registered in LocalChargePointService`);
    }
    return cp;
  }

  async syncLocalChargePoints(definitions: LocalChargePointDefinition[]): Promise<ChargePoint[]> {
    const seen = new Set<string>();

    for (const definition of definitions) {
      let cp = this.chargePoints.get(definition.id);
      seen.add(definition.id);

      if (!cp) {
        cp = this.buildChargePoint(definition);
        this.registerChargePoint(cp);
        continue;
      }

      cp.autoMeterValueSetting = definition.autoMeterValueSetting;
      // TODO: handle connector count changes if necessary
    }

    // Remove charge points that are no longer defined
    Array.from(this.chargePoints.keys()).forEach((id) => {
      if (!seen.has(id)) {
        this.unregisterChargePoint(id);
      }
    });

    return definitions
      .map((definition) => this.chargePoints.get(definition.id))
      .filter((value): value is ChargePoint => Boolean(value));
  }

  private buildChargePoint(definition: LocalChargePointDefinition): ChargePoint {
    const chargePoint = new ChargePoint(
      definition.id,
      definition.bootNotification,
      definition.connectorNumber,
      definition.wsUrl,
      definition.basicAuth,
      definition.autoMeterValueSetting,
    );

    // Restore connector-level settings from localStorage
    for (let connectorId = 1; connectorId <= definition.connectorNumber; connectorId++) {
      const savedConfig = loadConnectorAutoMeterConfig(definition.id, connectorId);
      if (!savedConfig) continue;

      const connector = chargePoint.getConnector(connectorId);
      if (!connector) continue;
      connector.autoMeterValueConfig = savedConfig;
    }

    return chargePoint;
  }

  private attachEventForwarders(chargePoint: ChargePoint): void {
    const unsubscribes: Array<() => void> = [];

    unsubscribes.push(
      chargePoint.events.on("statusChange", ({ status }) => {
        this.emit(chargePoint.id, { type: "status", status });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("error", ({ error }) => {
        this.emit(chargePoint.id, { type: "error", error });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("connectorStatusChange", ({ connectorId, status, previousStatus }) => {
        this.emit(chargePoint.id, {
          type: "connector-status",
          connectorId,
          status,
          previousStatus,
        });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("connectorAvailabilityChange", ({ connectorId, availability }) => {
        this.emit(chargePoint.id, {
          type: "connector-availability",
          connectorId,
          availability,
        });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("connectorTransactionChange", ({ connectorId, transactionId }) => {
        this.emit(chargePoint.id, {
          type: "connector-transaction",
          connectorId,
          transactionId,
        });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("connectorMeterValueChange", ({ connectorId, meterValue }) => {
        this.emit(chargePoint.id, {
          type: "connector-meter",
          connectorId,
          meterValue,
        });
      }),
    );

    chargePoint.connectors.forEach((connector) => {
      unsubscribes.push(
        connector.events.on("autoMeterValueChange", ({ config }) => {
          this.emit(chargePoint.id, {
            type: "connector-auto-meter",
            connectorId: connector.id,
            config,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("modeChange", ({ mode }) => {
          this.emit(chargePoint.id, {
            type: "connector-mode",
            connectorId: connector.id,
            mode,
          });
        }),
      );

      unsubscribes.push(
        connector.events.on("socChange", ({ soc }) => {
          this.emit(chargePoint.id, {
            type: "connector-soc",
            connectorId: connector.id,
            soc,
          });
        }),
      );

      connector.setOnMeterValueSend((id) => {
        chargePoint.sendMeterValue(id);
      });
    });

    unsubscribes.push(
      chargePoint.events.on("connected", () => {
        this.emit(chargePoint.id, { type: "connected" });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("disconnected", ({ code, reason }) => {
        this.emit(chargePoint.id, { type: "disconnected", code, reason });
      }),
    );

    unsubscribes.push(
      chargePoint.events.on("log", (entry) => {
        const logEntry: LogEntry = {
          timestamp: entry.timestamp,
          level: entry.level as LogLevel,
          type: entry.type as LogType,
          message: entry.message,
        };
        this.emit(chargePoint.id, { type: "log", entry: logEntry });
      }),
    );

    this.eventSubscriptions.set(chargePoint.id, unsubscribes);
  }

  private emit(id: string, event: ChargePointEvent): void {
    const listeners = this.listeners.get(id);
    if (!listeners) return;

    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error(`[LocalChargePointService] Listener error for charge point ${id}`, error);
      }
    });
  }
}
