import type { OCPPAvailability } from "../../../domain/types/OcppTypes";

/**
 * Validation level
 */
export type ValidationLevel = "OK" | "WARNING" | "ERROR";

/**
 * Validation result
 */
export interface ValidationResult {
  level: ValidationLevel;
  message?: string;
  details?: string[];
}

/**
 * Validation context
 */
export interface ValidationContext {
  source: string;
  currentTransaction?: number | null;
  currentAvailability?: OCPPAvailability;
  metadata?: Record<string, unknown>;
}
