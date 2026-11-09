import type { ChargePointStatus } from "../types/OcppTypes";
import type { HistoryOptions, StateHistoryEntry } from "./StateSnapshot";
import type {
  StateTransitionResult,
  TransitionContext,
} from "./StateTransition";

/**
 * The station's state history recorder as the charge point and the code
 * around it use it. `StateManager` (application) implements it;
 * `ChargePoint.stateManager` returns it.
 */
export interface ChargePointStateManager {
  readonly history: {
    /** The recorded transitions that match `options`. */
    getHistory(options?: HistoryOptions): StateHistoryEntry[];
  };
  /** Record a change of the charge point's own status. */
  transitionChargePointStatus(
    status: ChargePointStatus,
    context: TransitionContext,
  ): StateTransitionResult;
}
