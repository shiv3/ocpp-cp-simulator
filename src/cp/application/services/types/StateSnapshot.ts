import type { TransitionContext } from "./StateTransition";
import type { ValidationResult } from "./ValidationResult";

/**
 * State history entry
 */
export interface StateHistoryEntry {
  id: string; // UUID
  timestamp: Date;
  entity: "chargePoint" | "connector";
  entityId?: number; // for connector
  transitionType: "status" | "availability" | "transaction" | "error";
  fromState: string;
  toState: string;
  context: TransitionContext; // transition trigger information
  validationResult: ValidationResult;
  success: boolean;
  errorMessage?: string;
}

/**
 * History query options
 */
export interface HistoryOptions {
  entity?: "chargePoint" | "connector";
  entityId?: number;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  transitionType?: string;
  limit?: number;
}

/**
 * State statistics
 */
export interface StateStatistics {
  totalTransitions: number;
  transitionsByEntity: Record<string, number>;
  transitionsByType: Record<string, number>;
  errorCount: number;
  warningCount: number;
  averageTransitionsPerMinute: number;
}
