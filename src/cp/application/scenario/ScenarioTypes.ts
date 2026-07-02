import { Node, Edge } from "@xyflow/react";
import { OCPPStatus } from "../../domain/types/OcppTypes";
import { CurvePoint } from "../../domain/connector/MeterValueCurve";
import type { EVSettings } from "../../domain/connector/EVSettings";
import type {
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
} from "../../domain/connector/Transaction";

/**
 * Scenario execution mode
 */
export type ScenarioMode = "manual" | "scenario";

/**
 * Scenario execution state
 */
export type ScenarioExecutionState =
  | "idle"
  | "running"
  | "paused"
  | "stepping"
  | "waiting"
  | "completed"
  | "error";

/**
 * Scenario execution control mode
 */
export type ScenarioExecutionMode = "oneshot" | "step";

/**
 * Node types in the scenario flow
 */
export enum ScenarioNodeType {
  STATUS_CHANGE = "statusChange",
  TRANSACTION = "transaction",
  METER_VALUE = "meterValue",
  DELAY = "delay",
  NOTIFICATION = "notification",
  CONNECTOR_PLUG = "connectorPlug",
  REMOTE_START_TRIGGER = "remoteStartTrigger",
  REMOTE_STOP_TRIGGER = "remoteStopTrigger",
  STATUS_TRIGGER = "statusTrigger",
  RESERVE_NOW = "reserveNow",
  CANCEL_RESERVATION = "cancelReservation",
  RESERVATION_TRIGGER = "reservationTrigger",
  START = "start",
  END = "end",
  // §4.9: send a StatusNotification.req with explicit errorCode / info /
  // vendorErrorCode (e.g. Faulted + GroundFailure). Separate from
  // STATUS_CHANGE which only mutates connector.status.
  STATUS_NOTIFICATION = "statusNotification",
  // §5.18 / §7.46: configure the connector's next UnlockConnector
  // response without sending anything immediately.
  UNLOCK_OUTCOME = "unlockOutcome",
  // §5.3 ChangeConfiguration locally — useful for "shrink
  // MeterValueSampleInterval to 5s for this scenario".
  CONFIG_SET = "configSet",
  // §4.3 DataTransfer.req (CP → CSMS, vendor-specific).
  DATA_TRANSFER = "dataTransfer",
}

/**
 * Base node data
 */
export interface BaseNodeData {
  label: string;
  description?: string;
}

/**
 * Status Change Node Data
 */
export interface StatusChangeNodeData extends BaseNodeData {
  status: OCPPStatus;
}

/**
 * Transaction Node Data
 */
export interface TransactionNodeData extends BaseNodeData {
  action: "start" | "stop";
  tagId?: string; // Only for start
  batteryCapacityKwh?: number; // Battery capacity of the EV in kWh (e.g., 40, 60, 100)
  initialSoc?: number; // Initial State of Charge percentage (0-100)
}

export interface RemoteStartDetails {
  tagId: string;
  remoteStartId?: number;
}

export interface StartTransactionOptions {
  triggerReason?: TransactionStartTriggerReason;
  remoteStartId?: number;
}

export interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
}

/**
 * MeterValue Node Data
 */
export interface MeterValueNodeData extends BaseNodeData {
  value: number;
  sendMessage: boolean; // If true, send MeterValue message
  autoIncrement?: boolean; // If true, automatically increment meter value
  /** Simplified "how fast is the EV charging?" input expressed in kW.
   *  The editor derives `incrementAmount` from this on save (using the
   *  current `incrementInterval`) so the runtime scheduler keeps using
   *  its raw Wh-per-tick contract. Optional: when null/undefined the
   *  scenario was authored against the advanced inputs directly and the
   *  editor opens with the details panel expanded by default. */
  outputKw?: number;
  /** Simplified stop condition mirroring `maxValue` but expressed in kWh
   *  (the total energy delivered before auto-increment stops). The editor
   *  writes both this field AND `maxValue` (Wh) on save so older daemon
   *  builds that only read `maxValue` keep working. 0 = unlimited. */
  maxChargeKwh?: number;
  incrementInterval?: number; // Interval in seconds between auto-increments
  incrementAmount?: number; // Amount to increment each time (Wh)
  /**
   * How auto-increment decides when to stop.
   *  - "manual" (default, for back-compat): use `maxTime` and/or `maxValue` below.
   *  - "evSettings": use the connector's EV settings — stop when delivered Wh
   *    reaches `batteryCapacityKwh × (targetSoc − initialSoc) / 100 × 1000`.
   */
  stopMode?: "manual" | "evSettings";
  maxTime?: number; // Maximum time in seconds for auto-increment (0 = unlimited). Manual mode only.
  maxValue?: number; // Maximum meter value in Wh (0 = unlimited). Manual mode only.
  useCurve?: boolean; // If true, use curve-based auto increment
  curvePoints?: CurvePoint[]; // Control points for the curve
  autoCalculateInterval?: boolean; // If true, derive the curve interval from curve point spacing
}

/**
 * Delay Node Data
 */
export interface DelayNodeData extends BaseNodeData {
  delaySeconds: number;
}

/**
 * Notification Node Data
 */
export interface NotificationNodeData extends BaseNodeData {
  messageType: string; // e.g., "Authorize", "DataTransfer", etc.
  payload: Record<string, unknown>;
}

/**
 * Connector Plug Node Data
 */
export interface ConnectorPlugNodeData extends BaseNodeData {
  action: "plugin" | "plugout";
}

/**
 * Remote Start Trigger Node Data
 * This node waits for a RemoteStartTransaction request from the central system
 */
export interface RemoteStartTriggerNodeData extends BaseNodeData {
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
}

/**
 * Remote Stop Trigger Node Data
 *
 * Counterpart of RemoteStartTrigger. Blocks the scenario until the CSMS
 * sends RemoteStopTransaction.req for the currently-active transaction
 * on this connector. While the scenario is parked on this node, the
 * default RemoteStopTransactionHandler delegates the request to the
 * scenario instead of stopping the transaction itself — the scenario's
 * next node (typically a Transaction Stop) is what actually sends the
 * StopTransaction.req. Lets templates model "wait for CSMS to remote-stop,
 * then run the CP's stop-side cleanup" without racing the handler.
 */
export interface RemoteStopTriggerNodeData extends BaseNodeData {
  /** Optional timeout in seconds. 0 (default) = wait forever. */
  timeout?: number;
}

/**
 * Status Trigger Node Data
 * This node waits for the connector status to change to a specific state
 */
export interface StatusTriggerNodeData extends BaseNodeData {
  targetStatus: OCPPStatus; // Status to wait for
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
}

/**
 * Reserve Now Node Data
 * This node creates a reservation on the connector
 */
export interface ReserveNowNodeData extends BaseNodeData {
  expiryMinutes: number; // How long the reservation is valid (in minutes)
  idTag: string; // ID tag that can use the reservation
  parentIdTag?: string; // Optional parent ID tag
  reservationId?: number; // Optional reservation ID (auto-generated if not provided)
}

/**
 * Cancel Reservation Node Data
 * This node cancels an existing reservation
 */
export interface CancelReservationNodeData extends BaseNodeData {
  reservationId: number; // ID of the reservation to cancel
}

/**
 * Reservation Trigger Node Data
 * This node waits for a ReserveNow request from the central system
 */
export interface ReservationTriggerNodeData extends BaseNodeData {
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
}

/**
 * Start Node Data — configures when the scenario auto-starts.
 *
 * - `triggerOn: "connect"` (default): fire as soon as the CP is connected
 *   and BootNotification has been Accepted (i.e. `ChargePoint.status === Available`).
 * - `triggerOn: "status"`: fire when the bound connector reaches
 *   `targetStatus`. Also requires the CP to be Available — the connector
 *   status check is layered on top of the boot gate, not a substitute.
 *
 * The default is "connect" so existing scenarios (which carry no Start
 * node data beyond `label`) keep the previous auto-start behavior.
 */
export interface StartNodeData extends BaseNodeData {
  triggerOn?: "connect" | "status";
  targetStatus?: OCPPStatus;
}

/**
 * Status Notification Node Data — sends a full StatusNotification.req with
 * arbitrary errorCode / info / vendorErrorCode so scenarios can drive the
 * Faulted-with-context paths CSMS implementations care about (§4.9).
 *
 * Setting `connectorId` to 0 targets the CP main controller, in which
 * case `status` must be Available / Unavailable / Faulted (§7.7).
 */
export interface StatusNotificationNodeData extends BaseNodeData {
  status: OCPPStatus;
  errorCode?: string; // ChargePointErrorCode
  info?: string;
  vendorErrorCode?: string;
  vendorId?: string;
  /** Override which connector this targets. Defaults to the scenario's
   *  bound connector (or 0 for chargePoint-targeted scenarios). */
  connectorId?: number;
}

/**
 * Unlock Outcome Node Data — sets the connector's next UnlockConnector.req
 * response (§5.18 / §7.46). Does not emit any CSMS-bound message itself;
 * it's a pre-arm for the upcoming Central System call.
 */
export interface UnlockOutcomeNodeData extends BaseNodeData {
  outcome: "Unlocked" | "UnlockFailed" | "NotSupported";
}

/**
 * Config Set Node Data — applies a ChangeConfiguration locally (without
 * round-tripping through CSMS). Useful for tightening
 * MeterValueSampleInterval / changing MeterValuesSampledData mid-scenario.
 */
export interface ConfigSetNodeData extends BaseNodeData {
  key: string;
  value: string; // string form, parsed by ConfigurationStore per the key's type
}

/**
 * Data Transfer Node Data — issues a CP-initiated DataTransfer.req
 * (§4.3). Vendor / message id / payload are all user-controlled.
 */
export interface DataTransferNodeData extends BaseNodeData {
  vendorId: string;
  messageId?: string;
  data?: string;
}

/**
 * Union type for all node data
 */
export type ScenarioNodeData =
  | StatusChangeNodeData
  | TransactionNodeData
  | MeterValueNodeData
  | DelayNodeData
  | NotificationNodeData
  | ConnectorPlugNodeData
  | RemoteStartTriggerNodeData
  | RemoteStopTriggerNodeData
  | StatusTriggerNodeData
  | ReserveNowNodeData
  | CancelReservationNodeData
  | ReservationTriggerNodeData
  | StatusNotificationNodeData
  | UnlockOutcomeNodeData
  | ConfigSetNodeData
  | DataTransferNodeData
  | StartNodeData
  | BaseNodeData;

/**
 * Scenario node with typed data
 */
export type ScenarioNode = Node<ScenarioNodeData>;

/**
 * Scenario trigger configuration
 */
export interface ScenarioTrigger {
  type: "manual" | "statusChange";
  conditions?: {
    fromStatus?: OCPPStatus; // Optional: trigger only from specific status
    toStatus?: OCPPStatus; // Optional: trigger only to specific status
  };
}

/**
 * Scenario definition
 */
export interface ScenarioDefinition {
  id: string;
  name: string;
  description?: string;
  targetType: "chargePoint" | "connector";
  targetId?: number; // Connector ID if targetType is "connector"
  nodes: ScenarioNode[];
  edges: Edge[];
  createdAt: string;
  updatedAt: string;

  // Auto-execution settings
  trigger?: ScenarioTrigger; // Trigger configuration (default: manual)
  defaultExecutionMode?: ScenarioExecutionMode; // Default execution mode (default: oneshot)
  enabled?: boolean; // Enable/disable toggle (default: true)

  /**
   * Declarative EV settings applied to the target connector when this
   * scenario starts executing. A partial — only the listed fields are
   * written; the others keep their current value. Mid-scenario changes can
   * still be made via the `EV_SETTINGS_CHANGE` node.
   */
  evSettings?: Partial<EVSettings>;
}

/**
 * Scenario execution context
 */
export interface ScenarioExecutionContext {
  scenarioId: string;
  state: ScenarioExecutionState;
  mode: ScenarioExecutionMode;
  currentNodeId: string | null;
  executedNodes: string[];
  loopCount: number;
  error?: string;
}

/**
 * Connector scenarios collection
 * Stores multiple scenarios for a single connector
 */
export interface ConnectorScenariosCollection {
  version: number; // Storage version for migrations
  scenarios: ScenarioDefinition[]; // All scenarios for this connector
  activeScenarioIds?: string[]; // Currently executing scenario IDs
}

/**
 * Scenario executor callbacks
 */
export interface ScenarioExecutorCallbacks {
  onStatusChange?: (status: OCPPStatus) => Promise<void>;
  onStartTransaction?: (
    tagId: string,
    batteryCapacityKwh?: number,
    initialSoc?: number,
    options?: StartTransactionOptions,
  ) => Promise<void>;
  onStopTransaction?: (
    /** Optional OCPP §6.21 reason string. When a preceding
     *  RemoteStopTrigger node captured a CSMS-initiated stop, the
     *  scenario forwards "Remote" so StopTransaction.req carries the
     *  same reason the daemon would have set on the default
     *  RemoteStopTransactionHandler path. Other call sites can omit it
     *  and the connector / charge point default applies. */
    reason?: string,
    options?: StopTransactionOptions,
  ) => Promise<void>;
  onSetMeterValue?: (value: number) => void;
  onSendMeterValue?: () => Promise<void>;
  onStartAutoMeterValue?: (config: {
    intervalSeconds: number;
    incrementValue: number;
    maxTimeSeconds?: number;
    maxValue?: number;
  }) => void;
  onStopAutoMeterValue?: () => void;
  onSendNotification?: (
    messageType: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  onConnectorPlug?: (action: "plugin" | "plugout") => Promise<void>;
  onDelay?: (seconds: number) => Promise<void>;
  onWaitForRemoteStart?: (
    timeout?: number,
  ) => Promise<string | RemoteStartDetails>; // Returns tagId from RemoteStartTransaction
  /**
   * Block until CSMS sends RemoteStopTransaction.req for the currently
   * active transaction. Returns the requested transactionId so callers
   * can sanity-check it; if the timeout expires the promise rejects.
   * Implementations register a scenario-side handler so the default
   * RemoteStopTransactionHandler delegates instead of stopping the
   * transaction itself.
   */
  /** Resolves with `{ transactionId, reason }` so the next Transaction
   *  Stop node can pass the CSMS-supplied reason (defaults to "Remote")
   *  through to StopTransaction.req. */
  onWaitForRemoteStop?: (timeout?: number) => Promise<{
    transactionId: number;
    reason: string;
    triggerReason?: TransactionStopTriggerReason;
  }>;
  onWaitForStatus?: (
    targetStatus: OCPPStatus,
    timeout?: number,
  ) => Promise<void>; // Waits for status change
  onWaitForMeterValue?: (
    targetValue: number,
    timeout?: number,
  ) => Promise<void>; // Waits for meter value to reach target
  /** Read the connector's current meter accumulator (Wh). Used by the
   *  meterValue node to avoid clobbering a persisted value with the
   *  node's own `data.value` after a daemon restart resume. */
  onGetMeterValue?: () => number;
  onReserveNow?: (
    expiryMinutes: number,
    idTag: string,
    parentIdTag?: string,
    reservationId?: number,
  ) => Promise<number>; // Returns reservationId
  onCancelReservation?: (reservationId: number) => Promise<void>;
  onWaitForReservation?: (timeout?: number) => Promise<number>; // Returns reservationId from ReserveNow request
  /** Apply (merge) a partial EVSettings onto the target connector. */
  onSetEVSettings?: (settings: Partial<EVSettings>) => Promise<void> | void;
  /** Read the current EVSettings; used by meterValue stopMode="evSettings". */
  onGetEVSettings?: () => EVSettings | null;
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void; // Progress updates for long-running nodes
  onError?: (error: Error) => void;
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void; // Logger callback
  /** §4.9: send a StatusNotification.req with explicit errorCode/info. */
  onSendStatusNotification?: (
    connectorId: number,
    status: OCPPStatus,
    opts: {
      errorCode?: string;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
    },
  ) => void;
  /** §5.18 / §7.46: pre-arm the next UnlockConnector.req response. */
  onSetUnlockOutcome?: (
    outcome: "Unlocked" | "UnlockFailed" | "NotSupported",
  ) => void;
  /** §5.3: apply a Configuration key change locally. */
  onConfigSet?: (key: string, value: string) => void;
  /** §4.3: send CP-initiated DataTransfer.req. */
  onSendDataTransfer?: (
    vendorId: string,
    messageId?: string,
    data?: string,
  ) => void;
}

/**
 * Scenario event types with hierarchical structure for EventEmitter2
 *
 * Hierarchical event patterns:
 * - state.* - All state change events
 * - state.{stateName} - Specific state transitions (e.g., state.running, state.paused)
 * - node.* - All node-related events
 * - node.execute - All node executions
 * - node.complete - All node completions
 * - node.progress - All node progress updates
 * - node.{nodeType}.execute - Specific node type executions (e.g., node.DELAY.execute)
 * - execution.* - All execution control events
 * - execution.started - Execution started
 * - execution.paused - Execution paused
 * - execution.resumed - Execution resumed
 * - execution.stopped - Execution stopped
 * - execution.completed - Execution completed
 * - execution.error - Execution error
 */
export interface ScenarioEvents {
  // Backward compatibility - kept for existing code
  stateChange: {
    scenarioId: string;
    state: ScenarioExecutionState;
    previousState: ScenarioExecutionState;
  };
  nodeExecute: {
    scenarioId: string;
    nodeId: string;
    nodeType: ScenarioNodeType;
  };
  nodeComplete: {
    scenarioId: string;
    nodeId: string;
  };
  nodeProgress: {
    scenarioId: string;
    nodeId: string;
    remaining: number;
    total: number;
  };
  executionStarted: {
    scenarioId: string;
    mode: ScenarioExecutionMode;
  };
  executionPaused: {
    scenarioId: string;
  };
  executionResumed: {
    scenarioId: string;
  };
  executionStopped: {
    scenarioId: string;
  };
  executionCompleted: {
    scenarioId: string;
  };
  executionError: {
    scenarioId: string;
    error: string;
  };

  // Hierarchical state events - state.{stateName}
  "state.idle": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.running": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.paused": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.stepping": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.waiting": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.completed": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
  };
  "state.error": {
    scenarioId: string;
    previousState: ScenarioExecutionState;
    error?: string;
  };

  // Hierarchical node events - node.{event}
  "node.execute": {
    scenarioId: string;
    nodeId: string;
    nodeType: ScenarioNodeType;
  };
  "node.complete": {
    scenarioId: string;
    nodeId: string;
  };
  "node.progress": {
    scenarioId: string;
    nodeId: string;
    remaining: number;
    total: number;
  };

  // Hierarchical execution events - execution.{event}
  "execution.started": {
    scenarioId: string;
    mode: ScenarioExecutionMode;
  };
  "execution.paused": {
    scenarioId: string;
  };
  "execution.resumed": {
    scenarioId: string;
  };
  "execution.stopped": {
    scenarioId: string;
  };
  "execution.completed": {
    scenarioId: string;
  };
  "execution.error": {
    scenarioId: string;
    error: string;
  };

  // Dynamic hierarchical events for specific node types
  // These are string-indexed for flexibility with EventEmitter2 wildcards
  [key: string]: unknown;
}
