import { Node, Edge } from "@xyflow/react";
import { OCPPStatus } from "../../domain/types/OcppTypes";
import { CurvePoint } from "../../domain/connector/MeterValueCurve";

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
  STATUS_TRIGGER = "statusTrigger",
  RESERVE_NOW = "reserveNow",
  CANCEL_RESERVATION = "cancelReservation",
  RESERVATION_TRIGGER = "reservationTrigger",
  START = "start",
  END = "end",
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

/**
 * MeterValue Node Data
 */
export interface MeterValueNodeData extends BaseNodeData {
  value: number;
  sendMessage: boolean; // If true, send MeterValue message
  autoIncrement?: boolean; // If true, automatically increment meter value
  incrementInterval?: number; // Interval in seconds between auto-increments
  incrementAmount?: number; // Amount to increment each time (Wh)
  maxTime?: number; // Maximum time in seconds for auto-increment (0 = unlimited)
  maxValue?: number; // Maximum meter value in Wh (0 = unlimited)
  useCurve?: boolean; // If true, use curve-based auto increment
  curvePoints?: CurvePoint[]; // Control points for the curve
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
  | StatusTriggerNodeData
  | ReserveNowNodeData
  | CancelReservationNodeData
  | ReservationTriggerNodeData
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
  ) => Promise<void>;
  onStopTransaction?: () => Promise<void>;
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
  onWaitForRemoteStart?: (timeout?: number) => Promise<string>; // Returns tagId from RemoteStartTransaction
  onWaitForStatus?: (
    targetStatus: OCPPStatus,
    timeout?: number,
  ) => Promise<void>; // Waits for status change
  onReserveNow?: (
    expiryMinutes: number,
    idTag: string,
    parentIdTag?: string,
    reservationId?: number,
  ) => Promise<number>; // Returns reservationId
  onCancelReservation?: (reservationId: number) => Promise<void>;
  onWaitForReservation?: (timeout?: number) => Promise<number>; // Returns reservationId from ReserveNow request
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void; // Progress updates for long-running nodes
  onError?: (error: Error) => void;
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void; // Logger callback
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
