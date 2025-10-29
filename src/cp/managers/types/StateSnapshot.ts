import type { TransitionContext } from "./StateTransition";
import type { ValidationResult } from "./ValidationResult";

/**
 * 状態履歴エントリ
 */
export interface StateHistoryEntry {
  id: string; // UUID
  timestamp: Date;
  entity: "chargePoint" | "connector";
  entityId?: number; // connector の場合
  transitionType: "status" | "availability" | "transaction" | "error";
  fromState: string;
  toState: string;
  context: TransitionContext; // 遷移のトリガー情報
  validationResult: ValidationResult;
  success: boolean;
  errorMessage?: string;
}

/**
 * 履歴照会オプション
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
 * 状態統計情報
 */
export interface StateStatistics {
  totalTransitions: number;
  transitionsByEntity: Record<string, number>;
  transitionsByType: Record<string, number>;
  errorCount: number;
  warningCount: number;
  averageTransitionsPerMinute: number;
}
