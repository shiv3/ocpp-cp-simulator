import type { OCPPAvailability } from "../../../domain/types/OcppTypes";

/**
 * バリデーションレベル
 */
export type ValidationLevel = "OK" | "WARNING" | "ERROR";

/**
 * バリデーション結果
 */
export interface ValidationResult {
  level: ValidationLevel;
  message?: string;
  details?: string[];
}

/**
 * バリデーションコンテキスト
 */
export interface ValidationContext {
  source: string;
  currentTransaction?: number | null;
  currentAvailability?: OCPPAvailability;
  metadata?: Record<string, unknown>;
}
