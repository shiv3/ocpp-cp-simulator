import { interpret } from "robot3";
import type { Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { ChargePointEvents } from "../../domain/charge-point/ChargePointEvents";
import { StateHistory } from "./StateHistory";
import {
  createConnectorMachine,
  getStatusFromMachineState,
  type ConnectorContext,
  type ConnectorEvent,
} from "../state/machines/ConnectorStateMachine";
import type {
  StateTransitionResult,
  TransitionContext,
  ChargePointStateSnapshot,
  ConnectorStateSnapshot,
} from "./types/StateTransition";
import type { HistoryOptions, StateHistoryEntry } from "./types/StateSnapshot";
import { OCPPStatus, LogType } from "../../domain/types/OcppTypes";

interface ConnectorGetter {
  (id: number):
    | {
        status: string;
        availability: "Operative" | "Inoperative";
        transaction: { id: number } | null;
        meterValue: number;
      }
    | undefined;
}

interface ChargePointGetter {
  (): {
    status: OCPPStatus;
    error: string;
  };
}

/**
 * StateManager
 * Connector state management using Robot3
 */
export class StateManager {
  private connectorMachines: Map<number, ReturnType<typeof interpret>> =
    new Map();
  private connectorPreviousStatus: Map<number, OCPPStatus> = new Map();
  public readonly history: StateHistory;

  constructor(
    private logger: Logger,
    private eventEmitter: EventEmitter<ChargePointEvents>,
    private chargePointGetter: ChargePointGetter,
    private connectorGetter: ConnectorGetter,
  ) {
    this.history = new StateHistory(1000);

    // Listen to connector status changes and record them in history
    this.eventEmitter.on(
      "connectorStatusChange",
      ({ connectorId, status, previousStatus }) => {
        this.history.recordTransition({
          id: crypto.randomUUID(),
          timestamp: new Date(),
          entity: "connector",
          entityId: connectorId,
          transitionType: "status",
          fromState: previousStatus,
          toState: status,
          context: {
            source: "ChargePoint.updateConnectorStatus",
            timestamp: new Date(),
          },
          validationResult: {
            level: "OK",
          },
          success: true,
        });
      },
    );
  }

  /**
   * Initialize connector
   * @param connectorId Connector ID
   * @param initialStatus Initial status
   * @param availability Initial availability
   */
  initializeConnector(
    connectorId: number,
    initialStatus: OCPPStatus = OCPPStatus.Available,
    availability: "Operative" | "Inoperative" = "Operative",
  ): void {
    const initialContext: ConnectorContext = {
      connectorId,
      authorized: false,
      transactionId: null,
      tagId: null,
      availability,
    };

    const machine = createConnectorMachine(initialContext);

    // Monitor state changes
    const service = interpret(machine, (machineState) => {
      const status = getStatusFromMachineState(machineState.name);
      const previousStatus =
        this.connectorPreviousStatus.get(connectorId) || initialStatus;

      // Don't fire event if status is the same
      if (status === previousStatus) {
        return;
      }

      // Fire event
      this.eventEmitter.emit("connectorStatusChange", {
        connectorId,
        status,
        previousStatus,
      });

      // Log the change
      this.logger.info(
        `[StateManager] Connector ${connectorId} status: ${previousStatus} → ${status}`,
        LogType.System,
      );

      // Update previous status
      this.connectorPreviousStatus.set(connectorId, status);
    });

    this.connectorMachines.set(connectorId, service);
    this.connectorPreviousStatus.set(connectorId, initialStatus);
  }

  /**
   * Transition connector state
   * @param connectorId Connector ID
   * @param event Event
   * @param context Transition context
   * @returns Transition result
   */
  transitionConnectorStatus(
    connectorId: number,
    event: ConnectorEvent,
    context?: TransitionContext,
  ): StateTransitionResult {
    const service = this.connectorMachines.get(connectorId);

    if (!service) {
      const error = `Connector ${connectorId} not initialized`;
      this.logger.error(`[StateManager] ${error}`, LogType.System);
      return {
        success: false,
        error,
      };
    }

    const previousState = getStatusFromMachineState(service.machine.current);

    try {
      // Send event (Robot3 automatically executes validation)
      service.send(event);

      const newState = getStatusFromMachineState(service.machine.current);

      // Record history
      this.history.recordTransition({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        entity: "connector",
        entityId: connectorId,
        transitionType: "status",
        fromState: previousState,
        toState: newState,
        context: context || {
          source: "StateManager",
          timestamp: new Date(),
        },
        validationResult: {
          level: "OK",
        },
        success: true,
      });

      return {
        success: true,
        previousState,
        newState,
      };
    } catch (error: unknown) {
      // When transition is rejected due to guard condition failure, etc.
      const errorMessage =
        error instanceof Error ? error.message : "Transition failed";

      this.logger.error(
        `[StateManager] State transition failed for connector ${connectorId}: ${errorMessage}`,
        LogType.System,
      );

      // Record failure in history
      this.history.recordTransition({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        entity: "connector",
        entityId: connectorId,
        transitionType: "status",
        fromState: previousState,
        toState: previousState, // Same state because transition failed
        context: context || {
          source: "StateManager",
          timestamp: new Date(),
        },
        validationResult: {
          level: "ERROR",
          message: errorMessage,
        },
        success: false,
        errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
        previousState,
      };
    }
  }

  /**
   * Prepare transaction (transition to Preparing state)
   * @param connectorId Connector ID
   * @param tagId Tag ID
   * @returns Transition result
   */
  prepareTransaction(
    connectorId: number,
    tagId: string,
  ): StateTransitionResult {
    return this.transitionConnectorStatus(
      connectorId,
      { type: "PLUGIN" },
      {
        source: "prepareTransaction",
        timestamp: new Date(),
        metadata: { tagId },
      },
    );
  }

  /**
   * Start transaction (transition to Charging state)
   * @param connectorId Connector ID
   * @param transactionId Transaction ID
   * @param tagId Tag ID
   * @returns Transition result
   */
  startTransaction(
    connectorId: number,
    transactionId: number,
    tagId?: string,
  ): StateTransitionResult {
    const service = this.connectorMachines.get(connectorId);

    if (service && tagId) {
      // Authorize first
      service.send({ type: "AUTHORIZE", tagId });
    }

    // Start transaction
    return this.transitionConnectorStatus(
      connectorId,
      { type: "START_TRANSACTION", transactionId },
      {
        source: "startTransaction",
        timestamp: new Date(),
        metadata: { transactionId, tagId },
      },
    );
  }

  /**
   * Stop transaction (transition to Finishing state)
   * @param connectorId Connector ID
   * @param reason Stop reason
   * @returns Transition result
   */
  stopTransaction(connectorId: number, reason?: string): StateTransitionResult {
    return this.transitionConnectorStatus(
      connectorId,
      { type: "STOP_TRANSACTION", reason },
      {
        source: "stopTransaction",
        timestamp: new Date(),
        reason,
      },
    );
  }

  /**
   * Transition charge point state
   * @param status New status
   * @param context Transition context
   * @returns Transition result
   */
  transitionChargePointStatus(
    status: OCPPStatus,
    context: TransitionContext,
  ): StateTransitionResult {
    const chargePoint = this.chargePointGetter();
    const previousStatus = chargePoint.status;

    // Record history
    this.history.recordTransition({
      id: crypto.randomUUID(),
      timestamp: new Date(),
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
      LogType.System,
    );

    return {
      success: true,
      previousState: previousStatus,
      newState: status,
    };
  }

  /**
   * Get charge point state snapshot
   * @returns Snapshot
   */
  getChargePointState(): ChargePointStateSnapshot {
    const chargePoint = this.chargePointGetter();
    return {
      status: chargePoint.status,
      error: chargePoint.error,
      timestamp: new Date(),
    };
  }

  /**
   * Get connector state snapshot
   * @param connectorId Connector ID
   * @returns Snapshot
   */
  getConnectorState(connectorId: number): ConnectorStateSnapshot | null {
    const connector = this.connectorGetter(connectorId);
    if (!connector) {
      return null;
    }

    const service = this.connectorMachines.get(connectorId);
    const status = service
      ? getStatusFromMachineState(service.machine.current)
      : (connector.status as OCPPStatus);

    return {
      connectorId,
      status,
      availability: connector.availability,
      meterValue: connector.meterValue,
      transaction: connector.transaction
        ? {
            id: connector.transaction.id,
            tagId: "",
            startTime: new Date(),
            startMeter: 0,
          }
        : null,
      timestamp: new Date(),
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
    this.connectorMachines.clear();
    this.connectorPreviousStatus.clear();
    this.history.clear();
  }
}
