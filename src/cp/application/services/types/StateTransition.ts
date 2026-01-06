import type {
  OCPPStatus,
  OCPPAvailability,
} from "../../../domain/types/OcppTypes";
import type { Transaction } from "../../../domain/connector/Transaction";

/**
 * State transition result
 */
export interface StateTransitionResult {
  success: boolean;
  error?: string;
  previousState?: string;
  newState?: string;
  warnings?: string[];
}

/**
 * State transition context information
 */
export interface TransitionContext {
  source: string; // 'RemoteStartTransaction', 'UI', 'Boot', etc.
  timestamp: Date;
  ocppMessageId?: string; // OCPP message correlation ID
  reason?: string; // Additional information
  metadata?: Record<string, unknown>;
}

/**
 * ChargePoint state snapshot
 */
export interface ChargePointStateSnapshot {
  status: OCPPStatus;
  error: string;
  timestamp: Date;
}

/**
 * Connector state snapshot
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
 * Connector information (for validation)
 */
export interface ConnectorInfo {
  id: number;
  status: OCPPStatus;
  availability: OCPPAvailability;
  transaction: Transaction | null;
}
