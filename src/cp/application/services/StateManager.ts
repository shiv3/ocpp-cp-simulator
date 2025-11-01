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
  (id: number): {
    status: string;
    availability: "Operative" | "Inoperative";
    transaction: { id: number } | null;
    meterValue: number;
  } | undefined;
}

interface ChargePointGetter {
  (): {
    status: OCPPStatus;
    error: string;
  };
}

/**
 * StateManager
 * Robot3を使ったConnector状態管理
 */
export class StateManager {
  private connectorMachines: Map<number, any> = new Map();
  private connectorPreviousStatus: Map<number, OCPPStatus> = new Map();
  public readonly history: StateHistory;

  constructor(
    private logger: Logger,
    private eventEmitter: EventEmitter<ChargePointEvents>,
    private chargePointGetter: ChargePointGetter,
    private connectorGetter: ConnectorGetter
  ) {
    this.history = new StateHistory(1000);

    // Listen to connector status changes and record them in history
    this.eventEmitter.on("connectorStatusChange", ({ connectorId, status, previousStatus }) => {
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
    });
  }

  /**
   * Connectorを初期化
   * @param connectorId Connector ID
   * @param initialStatus 初期ステータス
   * @param availability 初期Availability
   */
  initializeConnector(
    connectorId: number,
    initialStatus: OCPPStatus = OCPPStatus.Available,
    availability: "Operative" | "Inoperative" = "Operative"
  ): void {
    const initialContext: ConnectorContext = {
      connectorId,
      authorized: false,
      transactionId: null,
      tagId: null,
      availability,
    };

    const machine = createConnectorMachine(initialContext);

    // 状態変更を監視
    const service = interpret(machine, (machineState) => {
      const status = getStatusFromMachineState(machineState.name);
      const previousStatus =
        this.connectorPreviousStatus.get(connectorId) || initialStatus;

      // 前回と同じ状態の場合はイベント発火しない
      if (status === previousStatus) {
        return;
      }

      // イベント発火
      this.eventEmitter.emit("connectorStatusChange", {
        connectorId,
        status,
        previousStatus,
      });

      // ログ記録
      this.logger.info(
        `[StateManager] Connector ${connectorId} status: ${previousStatus} → ${status}`,
        LogType.System
      );

      // 前回のステータスを更新
      this.connectorPreviousStatus.set(connectorId, status);
    });

    this.connectorMachines.set(connectorId, service);
    this.connectorPreviousStatus.set(connectorId, initialStatus);
  }

  /**
   * Connector状態を遷移
   * @param connectorId Connector ID
   * @param event イベント
   * @param context 遷移コンテキスト
   * @returns 遷移結果
   */
  transitionConnectorStatus(
    connectorId: number,
    event: ConnectorEvent,
    context?: TransitionContext
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
      // イベント送信（Robot3が自動的にvalidation実行）
      service.send(event);

      const newState = getStatusFromMachineState(service.machine.current);

      // 履歴記録
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
    } catch (error: any) {
      // Guard条件失敗などで遷移が拒否された場合
      const errorMessage = error.message || "Transition failed";

      this.logger.error(
        `[StateManager] State transition failed for connector ${connectorId}: ${errorMessage}`,
        LogType.System
      );

      // 失敗を履歴に記録
      this.history.recordTransition({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        entity: "connector",
        entityId: connectorId,
        transitionType: "status",
        fromState: previousState,
        toState: previousState, // 遷移失敗なので同じ状態
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
   * Transactionを準備（Preparing状態に遷移）
   * @param connectorId Connector ID
   * @param tagId Tag ID
   * @returns 遷移結果
   */
  prepareTransaction(connectorId: number, tagId: string): StateTransitionResult {
    return this.transitionConnectorStatus(
      connectorId,
      { type: "PLUGIN" },
      {
        source: "prepareTransaction",
        timestamp: new Date(),
        metadata: { tagId },
      }
    );
  }

  /**
   * Transactionを開始（Charging状態に遷移）
   * @param connectorId Connector ID
   * @param transactionId Transaction ID
   * @param tagId Tag ID
   * @returns 遷移結果
   */
  startTransaction(
    connectorId: number,
    transactionId: number,
    tagId?: string
  ): StateTransitionResult {
    const service = this.connectorMachines.get(connectorId);

    if (service && tagId) {
      // まず認証
      service.send({ type: "AUTHORIZE", tagId });
    }

    // Transactionを開始
    return this.transitionConnectorStatus(
      connectorId,
      { type: "START_TRANSACTION", transactionId },
      {
        source: "startTransaction",
        timestamp: new Date(),
        metadata: { transactionId, tagId },
      }
    );
  }

  /**
   * Transactionを停止（Finishing状態に遷移）
   * @param connectorId Connector ID
   * @param reason 停止理由
   * @returns 遷移結果
   */
  stopTransaction(
    connectorId: number,
    reason?: string
  ): StateTransitionResult {
    return this.transitionConnectorStatus(
      connectorId,
      { type: "STOP_TRANSACTION", reason },
      {
        source: "stopTransaction",
        timestamp: new Date(),
        reason,
      }
    );
  }

  /**
   * ChargePoint状態を遷移
   * @param status 新しいステータス
   * @param context 遷移コンテキスト
   * @returns 遷移結果
   */
  transitionChargePointStatus(
    status: OCPPStatus,
    context: TransitionContext
  ): StateTransitionResult {
    const chargePoint = this.chargePointGetter();
    const previousStatus = chargePoint.status;

    // 履歴記録
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
      LogType.System
    );

    return {
      success: true,
      previousState: previousStatus,
      newState: status,
    };
  }

  /**
   * ChargePoint状態のスナップショットを取得
   * @returns スナップショット
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
   * Connector状態のスナップショットを取得
   * @param connectorId Connector ID
   * @returns スナップショット
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
   * 状態履歴を取得
   * @param options 照会オプション
   * @returns 履歴エントリの配列
   */
  getStateHistory(options?: HistoryOptions): StateHistoryEntry[] {
    return this.history.getHistory(options);
  }

  /**
   * 統計情報を取得
   */
  getStatistics() {
    return this.history.getStatistics();
  }

  /**
   * クリーンアップ
   */
  cleanup(): void {
    this.connectorMachines.clear();
    this.connectorPreviousStatus.clear();
    this.history.clear();
  }
}
