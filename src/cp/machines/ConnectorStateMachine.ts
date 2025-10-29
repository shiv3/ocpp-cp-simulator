import { createMachine, state, transition, guard, reduce } from "robot3";
import { OCPPStatus } from "../OcppTypes";

/**
 * Connector の状態マシンコンテキスト
 */
export interface ConnectorContext {
  connectorId: number;
  authorized: boolean;
  transactionId: number | null;
  tagId: string | null;
  availability: "Operative" | "Inoperative";
}

/**
 * Connector イベント型定義
 */
export type ConnectorEvent =
  | { type: "PLUGIN" }
  | { type: "AUTHORIZE"; tagId: string }
  | { type: "START_TRANSACTION"; transactionId: number }
  | { type: "STOP_TRANSACTION"; reason?: string }
  | { type: "PLUGOUT" }
  | { type: "ERROR"; errorCode: string }
  | { type: "RESERVE"; reservationId: number }
  | { type: "CANCEL_RESERVATION" }
  | { type: "RESET" }
  | { type: "SUSPEND_EV" }
  | { type: "SUSPEND_EVSE"; reason: string }
  | { type: "RESUME" }
  | { type: "SET_UNAVAILABLE" }
  | { type: "SET_AVAILABLE" };

// Guards（遷移条件）
const isAuthorized = (ctx: ConnectorContext) => ctx.authorized === true;
const isOperative = (ctx: ConnectorContext) => ctx.availability === "Operative";

/**
 * Connector State Machine を作成
 * @param initialContext 初期コンテキスト
 * @returns Robot3 state machine
 */
export function createConnectorMachine(initialContext: ConnectorContext) {
  return createMachine(
    {
      // Available 状態
      available: state(
        transition(
          "PLUGIN",
          "preparing",
          guard(isOperative),
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            authorized: false,
          }))
        ),
        transition("RESERVE", "reserved"),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted")
      ),

      // Preparing 状態
      preparing: state(
        transition(
          "AUTHORIZE",
          "preparing",
          reduce((ctx: ConnectorContext, event: ConnectorEvent) => ({
            ...ctx,
            authorized: true,
            tagId: event.type === "AUTHORIZE" ? event.tagId : ctx.tagId,
          }))
        ),
        transition(
          "START_TRANSACTION",
          "charging",
          guard(isAuthorized),
          reduce((ctx: ConnectorContext, event: ConnectorEvent) => ({
            ...ctx,
            transactionId:
              event.type === "START_TRANSACTION"
                ? event.transactionId
                : ctx.transactionId,
          }))
        ),
        transition(
          "PLUGOUT",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            authorized: false,
            tagId: null,
          }))
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted")
      ),

      // Charging 状態
      charging: state(
        transition("SUSPEND_EV", "suspendedEV"),
        transition("SUSPEND_EVSE", "suspendedEVSE"),
        transition(
          "STOP_TRANSACTION",
          "finishing",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
          }))
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted")
      ),

      // SuspendedEV 状態
      suspendedEV: state(
        transition("RESUME", "charging"),
        transition("SUSPEND_EVSE", "suspendedEVSE"),
        transition(
          "STOP_TRANSACTION",
          "finishing",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
          }))
        ),
        transition("ERROR", "faulted")
      ),

      // SuspendedEVSE 状態
      suspendedEVSE: state(
        transition("RESUME", "charging"),
        transition("SUSPEND_EV", "suspendedEV"),
        transition(
          "STOP_TRANSACTION",
          "finishing",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
          }))
        ),
        transition("ERROR", "faulted")
      ),

      // Finishing 状態
      finishing: state(
        transition(
          "PLUGOUT",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
            tagId: null,
          }))
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted")
      ),

      // Reserved 状態
      reserved: state(
        transition("PLUGIN", "preparing", guard(isOperative)),
        transition(
          "CANCEL_RESERVATION",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            tagId: null,
          }))
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted")
      ),

      // Unavailable 状態
      unavailable: state(
        transition(
          "SET_AVAILABLE",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            availability: "Operative",
          }))
        ),
        transition("ERROR", "faulted")
      ),

      // Faulted 状態
      faulted: state(
        transition(
          "RESET",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
            tagId: null,
          }))
        ),
        transition("SET_UNAVAILABLE", "unavailable")
      ),
    },
    // 初期コンテキスト
    (initialState) => ({
      ...initialContext,
      current: initialState,
    })
  );
}

/**
 * マシン状態名からOCPPStatusへのマッピング
 * @param machineState Robot3のstate名
 * @returns OCPPStatus
 */
export function getStatusFromMachineState(machineState: string): OCPPStatus {
  const mapping: Record<string, OCPPStatus> = {
    available: OCPPStatus.Available,
    preparing: OCPPStatus.Preparing,
    charging: OCPPStatus.Charging,
    suspendedEV: OCPPStatus.SuspendedEV,
    suspendedEVSE: OCPPStatus.SuspendedEVSE,
    finishing: OCPPStatus.Finishing,
    reserved: OCPPStatus.Reserved,
    unavailable: OCPPStatus.Unavailable,
    faulted: OCPPStatus.Faulted,
  };
  return mapping[machineState] || OCPPStatus.Faulted;
}

/**
 * OCPPStatusからマシン状態名へのマッピング
 * @param status OCPPStatus
 * @returns Robot3のstate名
 */
export function getMachineStateFromStatus(status: OCPPStatus): string {
  const mapping: Record<OCPPStatus, string> = {
    [OCPPStatus.Available]: "available",
    [OCPPStatus.Preparing]: "preparing",
    [OCPPStatus.Charging]: "charging",
    [OCPPStatus.SuspendedEV]: "suspendedEV",
    [OCPPStatus.SuspendedEVSE]: "suspendedEVSE",
    [OCPPStatus.Finishing]: "finishing",
    [OCPPStatus.Reserved]: "reserved",
    [OCPPStatus.Unavailable]: "unavailable",
    [OCPPStatus.Faulted]: "faulted",
  };
  return mapping[status] || "faulted";
}
