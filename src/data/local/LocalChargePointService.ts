import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { ChargePointEvent, ChargePointService, ChargePointSnapshot, ConnectorSnapshot } from "../interfaces/ChargePointService";

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

export class LocalChargePointService implements ChargePointService {
  private readonly chargePoints = new Map<string, ChargePoint>();
  private readonly listeners = new Map<string, Set<(event: ChargePointEvent) => void>>();

  registerChargePoint(chargePoint: ChargePoint): void {
    this.chargePoints.set(chargePoint.id, chargePoint);
  }

  unregisterChargePoint(id: string): void {
    this.chargePoints.delete(id);
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
}
