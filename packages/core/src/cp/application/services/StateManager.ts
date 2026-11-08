import type { Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { ChargePointEvents } from "../../domain/charge-point/ChargePointEvents";
import { StateHistory } from "./StateHistory";
import type {
  StateTransitionResult,
  TransitionContext,
} from "./types/StateTransition";
import type { HistoryOptions, StateHistoryEntry } from "./types/StateSnapshot";
import type { ChargePointStatus } from "../../domain/types/OcppTypes";
import { LogType } from "../../domain/types/OcppTypes";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";

interface ChargePointGetter {
  (): {
    status: ChargePointStatus;
    error: string;
  };
}

/**
 * StateManager records StateHistory. The charger engine owns connector state
 * and publishes every status change as `connectorStatusChange`; this class
 * turns those events, and the charge point's own status changes, into history
 * entries. It holds no state machine and changes no state.
 */
export class StateManager {
  public readonly history: StateHistory;

  constructor(
    private logger: Logger,
    private eventEmitter: EventEmitter<ChargePointEvents>,
    private chargePointGetter: ChargePointGetter,
    private clock: SimClock = realClock,
    private ids: Rng = systemRngStreams.stream("", "state-history"),
  ) {
    this.history = new StateHistory(1000);

    this.eventEmitter.on(
      "connectorStatusChange",
      ({ connectorId, status, previousStatus }) => {
        this.history.recordTransition({
          id: this.ids.uuid(),
          timestamp: this.nowDate(),
          entity: "connector",
          entityId: connectorId,
          transitionType: "status",
          fromState: previousStatus,
          toState: status,
          context: {
            source: "ChargePoint.updateConnectorStatus",
            timestamp: this.nowDate(),
          },
          validationResult: {
            level: "OK",
          },
          success: true,
        });
      },
    );
  }

  private nowDate(): Date {
    return new Date(this.clock.now());
  }

  /**
   * Transition charge point state
   * @param status New status
   * @param context Transition context
   * @returns Transition result
   */
  transitionChargePointStatus(
    status: ChargePointStatus,
    context: TransitionContext,
  ): StateTransitionResult {
    const chargePoint = this.chargePointGetter();
    const previousStatus = chargePoint.status;

    // Record history
    this.history.recordTransition({
      id: this.ids.uuid(),
      timestamp: this.nowDate(),
      entity: "chargePoint",
      transitionType: "status",
      fromState: previousStatus,
      toState: status,
      context,
      validationResult: {
        level: "OK",
      },
      success: true,
    });

    this.logger.info(
      `[StateManager] ChargePoint status: ${previousStatus} → ${status}`,
      LogType.SYSTEM,
    );

    return {
      success: true,
      previousState: previousStatus,
      newState: status,
    };
  }

  /**
   * Get state history
   * @param options Query options
   * @returns Array of history entries
   */
  getStateHistory(options?: HistoryOptions): StateHistoryEntry[] {
    return this.history.getHistory(options);
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return this.history.getStatistics();
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    this.history.clear();
  }
}
