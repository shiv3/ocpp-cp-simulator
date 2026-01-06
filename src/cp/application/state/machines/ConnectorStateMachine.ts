import { createMachine, state, transition, guard, reduce } from "robot3";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * Connector state machine context
 */
export interface ConnectorContext {
  connectorId: number;
  authorized: boolean;
  transactionId: number | null;
  tagId: string | null;
  availability: "Operative" | "Inoperative";
}

/**
 * Connector event type definitions
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

// Guards (transition conditions)
const isAuthorized = (ctx: ConnectorContext) => ctx.authorized === true;
const isOperative = (ctx: ConnectorContext) => ctx.availability === "Operative";

/**
 * Create Connector State Machine
 * @param initialContext Initial context
 * @returns Robot3 state machine
 */
export function createConnectorMachine(initialContext: ConnectorContext) {
  return createMachine(
    {
      // Available state
      available: state(
        transition(
          "PLUGIN",
          "preparing",
          guard(isOperative),
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            authorized: false,
          })),
        ),
        transition("RESERVE", "reserved"),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted"),
      ),

      // Preparing state
      preparing: state(
        transition(
          "AUTHORIZE",
          "preparing",
          reduce((ctx: ConnectorContext, event: ConnectorEvent) => ({
            ...ctx,
            authorized: true,
            tagId: event.type === "AUTHORIZE" ? event.tagId : ctx.tagId,
          })),
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
          })),
        ),
        transition(
          "PLUGOUT",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            authorized: false,
            tagId: null,
          })),
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted"),
      ),

      // Charging state
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
          })),
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted"),
      ),

      // SuspendedEV state
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
          })),
        ),
        transition("ERROR", "faulted"),
      ),

      // SuspendedEVSE state
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
          })),
        ),
        transition("ERROR", "faulted"),
      ),

      // Finishing state
      finishing: state(
        transition(
          "PLUGOUT",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
            tagId: null,
          })),
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted"),
      ),

      // Reserved state
      reserved: state(
        transition("PLUGIN", "preparing", guard(isOperative)),
        transition(
          "CANCEL_RESERVATION",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            tagId: null,
          })),
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
        transition("ERROR", "faulted"),
      ),

      // Unavailable state
      unavailable: state(
        transition(
          "SET_AVAILABLE",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            availability: "Operative",
          })),
        ),
        transition("ERROR", "faulted"),
      ),

      // Faulted state
      faulted: state(
        transition(
          "RESET",
          "available",
          reduce((ctx: ConnectorContext) => ({
            ...ctx,
            transactionId: null,
            authorized: false,
            tagId: null,
          })),
        ),
        transition("SET_UNAVAILABLE", "unavailable"),
      ),
    },
    // Initial context
    (initialState) => ({
      ...initialContext,
      current: initialState,
    }),
  );
}

/**
 * Mapping from machine state name to OCPPStatus
 * @param machineState Robot3 state name
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
 * Mapping from OCPPStatus to machine state name
 * @param status OCPPStatus
 * @returns Robot3 state name
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
