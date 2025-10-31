import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { OCPPAvailability, OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { LogEntry } from "../../cp/shared/Logger";

export interface ConnectorSnapshot {
  id: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  meterValue: number;
  transactionId: number | null;
}

export interface ChargePointSnapshot {
  id: string;
  status: OCPPStatus;
  error: string;
  connectors: ConnectorSnapshot[];
}

export type ChargePointEvent =
  | { type: "status"; status: OCPPStatus }
  | { type: "error"; error: string }
  | { type: "connector-status"; connectorId: number; status: OCPPStatus; previousStatus: OCPPStatus }
  | { type: "connector-availability"; connectorId: number; availability: OCPPAvailability }
  | { type: "connector-transaction"; connectorId: number; transactionId: number | null }
  | { type: "connector-meter"; connectorId: number; meterValue: number }
  | { type: "log"; entry: LogEntry }
  | { type: "connected" }
  | { type: "disconnected"; code: number; reason: string };

export interface ChargePointService {
  listChargePoints(): Promise<ChargePointSnapshot[]>;
  getChargePoint(id: string): Promise<ChargePointSnapshot | null>;
  getChargePointHandle?(id: string): ChargePoint | null;

  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  sendHeartbeat(id: string): Promise<void>;
  startHeartbeat(id: string, intervalSeconds: number): Promise<void>;
  stopHeartbeat(id: string): Promise<void>;

  startTransaction(id: string, connectorId: number, tagId: string): Promise<void>;
  stopTransaction(id: string, connectorId: number): Promise<void>;
  sendStatusNotification(id: string, connectorId: number, status: OCPPStatus): Promise<void>;
  setMeterValue(id: string, connectorId: number, value: number): Promise<void>;
  sendMeterValue(id: string, connectorId: number): Promise<void>;

  subscribe(
    id: string,
    handler: (event: ChargePointEvent) => void,
  ): () => void;
}
