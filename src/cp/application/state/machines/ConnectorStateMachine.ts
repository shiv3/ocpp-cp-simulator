import {
  createMachine,
  state,
  transition,
  guard,
  reduce,
  type Service,
  type Transition,
} from "robot3";
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

/**
 * robot3's `state()` infers its event type from the first transition alone,
 * so a state with several events does not type-check; pin it to the full
 * connector event union.
 */
const connectorState = (...transitions: Transition<ConnectorEvent["type"]>[]) =>
  state(...transitions);

// Guards (transition conditions)
const isAuthorized = (ctx: ConnectorContext) => ctx.authorized === true;
const isOperative = (ctx: ConnectorContext) => ctx.availability === "Operative";

/**
 * Allowed next OCPP statuses for operator-driven status changes. This mirrors
 * the Robot3 transitions below and is exported so UI controls do not drift
 * from the authoritative connector state machine.
 */
export const ALLOWED_CONNECTOR_STATUS_TRANSITIONS: Readonly<
  Record<OCPPStatus, ReadonlyArray<OCPPStatus>>
> = {
  [OCPPStatus.Available]: [
    OCPPStatus.Preparing,
    OCPPStatus.Reserved,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Preparing]: [
    OCPPStatus.Charging,
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Charging]: [
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.SuspendedEV]: [
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.SuspendedEVSE]: [
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.Finishing,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Finishing]: [
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Reserved]: [
    OCPPStatus.Preparing,
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Unavailable]: [OCPPStatus.Available, OCPPStatus.Faulted],
  [OCPPStatus.Faulted]: [OCPPStatus.Available, OCPPStatus.Unavailable],
};

/**
 * Create Connector State Machine
 * @param initialContext Initial context
 * @returns Robot3 state machine
 */
export function createConnectorMachine(initialContext: ConnectorContext) {
  return createMachine(
    {
      // Available state
      available: connectorState(
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
      preparing: connectorState(
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
      charging: connectorState(
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
      suspendedEV: connectorState(
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
      suspendedEVSE: connectorState(
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
      finishing: connectorState(
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
      reserved: connectorState(
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
      unavailable: connectorState(
        transition(
          "SET_AVAILABLE",
          "available",
          reduce((ctx: ConnectorContext): ConnectorContext => ({
            ...ctx,
            availability: "Operative",
          })),
        ),
        transition("ERROR", "faulted"),
      ),

      // Faulted state
      faulted: connectorState(
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
    // Initial context. robot3 passes this function the context given to
    // `interpret`, which no caller supplies.
    (): ConnectorContext => ({ ...initialContext }),
  );
}

/** A running (`interpret`ed) machine built by {@link createConnectorMachine}. */
export type ConnectorMachineService = Service<
  ReturnType<typeof createConnectorMachine>
>;

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
