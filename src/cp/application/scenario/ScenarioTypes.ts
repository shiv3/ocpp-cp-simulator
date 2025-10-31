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
export type ScenarioExecutionState = "idle" | "running" | "paused" | "completed" | "error";

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
  payload: Record<string, any>;
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
    toStatus?: OCPPStatus;   // Optional: trigger only to specific status
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
  trigger?: ScenarioTrigger;              // Trigger configuration (default: manual)
  defaultExecutionMode?: ScenarioExecutionMode; // Default execution mode (default: oneshot)
  enabled?: boolean;                       // Enable/disable toggle (default: true)
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
  version: number;                    // Storage version for migrations
  scenarios: ScenarioDefinition[];    // All scenarios for this connector
  activeScenarioIds?: string[];       // Currently executing scenario IDs
}

/**
 * Scenario executor callbacks
 */
export interface ScenarioExecutorCallbacks {
  onStatusChange?: (status: OCPPStatus) => Promise<void>;
  onStartTransaction?: (tagId: string) => Promise<void>;
  onStopTransaction?: () => Promise<void>;
  onSetMeterValue?: (value: number) => void;
  onSendMeterValue?: () => Promise<void>;
  onSendNotification?: (messageType: string, payload: Record<string, any>) => Promise<void>;
  onConnectorPlug?: (action: "plugin" | "plugout") => Promise<void>;
  onDelay?: (seconds: number) => Promise<void>;
  onWaitForRemoteStart?: (timeout?: number) => Promise<string>; // Returns tagId from RemoteStartTransaction
  onWaitForStatus?: (targetStatus: OCPPStatus, timeout?: number) => Promise<void>; // Waits for status change
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void; // Progress updates for long-running nodes
  onError?: (error: Error) => void;
}
