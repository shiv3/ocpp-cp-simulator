import type { OCPPStatus, OCPPAvailability } from "../../../domain/types/OcppTypes";
import type { Transaction } from "../../../domain/connector/Transaction";

/**
 * 状態遷移の結果
 */
export interface StateTransitionResult {
  success: boolean;
  error?: string;
  previousState?: string;
  newState?: string;
  warnings?: string[];
}

/**
 * 状態遷移のコンテキスト情報
 */
export interface TransitionContext {
  source: string; // 'RemoteStartTransaction', 'UI', 'Boot', etc.
  timestamp: Date;
  ocppMessageId?: string; // OCPP message correlation ID
  reason?: string; // 追加情報
  metadata?: Record<string, unknown>;
}

/**
 * ChargePoint の状態スナップショット
 */
export interface ChargePointStateSnapshot {
  status: OCPPStatus;
  error: string;
  timestamp: Date;
}

/**
 * Connector の状態スナップショット
 */
export interface ConnectorStateSnapshot {
  connectorId: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  meterValue: number;
  transaction: {
    id: number;
    tagId: string;
    startTime: Date;
    startMeter: number;
  } | null;
  timestamp: Date;
}

/**
 * Connector情報（バリデーション用）
 */
export interface ConnectorInfo {
  id: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  transaction: Transaction | null;
}
