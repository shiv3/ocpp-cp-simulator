import type { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { EVSettings } from "../../../domain/connector/EVSettings";
import type { TransactionStopTriggerReason } from "../../../domain/connector/Transaction";
import type { StartTransactionOutcome } from "../../../domain/charge-point/ChargePoint";
import type { ResponseOverrideRequest } from "../../../domain/charge-point/responseOverrideRequest";
import type {
  OcppCallOutcome,
  OcppCallRequest,
} from "../../../domain/types/OcppCall";
import type {
  CallResponseSpec,
  NotifyKind,
  RemoteStartDetails,
  ScenarioNodeType,
  ScenarioExecutionMode,
  ScenarioExecutionState,
  StartTransactionOptions,
  StopTransactionOptions,
} from "./nodeData";
import type { ScenarioDefinition } from "./graph";

/**
 * Normalized description of the external condition a parked scenario node is
 * waiting for (#179). Surfaced on `ScenarioExecutionContext` while a waiting
 * node (a CSMS-call / status / reservation trigger) is blocked, so a headless
 * runner can see *what* the scenario expects next without parsing scenario
 * JSON internals.
 */
export interface ScenarioExpectation {
  /** What kind of condition the parked node awaits. */
  type: "ocpp_call" | "connector_status" | "reservation" | "connection";
  /** For ocpp_call / reservation: who must send the awaited CALL. */
  direction?: "CSMS_TO_CP" | "CP_TO_CSMS";
  /** For ocpp_call / reservation: the OCPP action awaited. */
  action?: string;
  /** For connector_status: the status the connector must reach. */
  targetStatus?: string;
  /** For connection: the WebSocket state transition awaited (#240). */
  event?: "connected" | "disconnected";
  /** Partial-match constraints on the awaited event (e.g. connectorId).
   *  Superset-matched, never exhaustive. */
  constraints?: Record<string, unknown>;
  /** Node timeout in ms (node.data.timeout seconds × 1000). Absent / 0 =
   *  wait forever. */
  timeoutMs?: number;
  /** The graph node currently parked. */
  nodeId: string;
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
  /** #179: while a waiting node is parked, the normalized condition it
   *  awaits. Null / absent when no node is parked. */
  expectation?: ScenarioExpectation | null;
  /** #179: stable identifier for this execution, set by the service layer so
   *  a poller can tie status to a specific run. */
  runId?: string;
  /** #240: epoch ms when the current node began executing; null when no
   *  node is active. Lets a client compute time-on-step and, with
   *  expectation.timeoutMs, the remaining wait. */
  currentNodeStartedAt?: number | null;
  /** #240: epoch ms when the parked wait times out; null when no wait is
   *  parked or it waits forever. Moves when an operator extends or retries
   *  the wait, so prefer it over expectation.timeoutMs for a countdown. */
  waitDeadlineAt?: number | null;
}

/** #240: an operator action taken on a parked wait. */
export interface ScenarioWaitIntervention {
  kind: "extend" | "retry" | "continue";
  /** The node whose wait was acted on. */
  nodeId: string;
  /** Epoch ms of the action. */
  at: number;
  /** For extend: seconds added to the deadline. */
  seconds?: number;
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
/** A `csmsCallTrigger` with `behavior: "replace"` asks the station to hand
 *  it the CALL (schema 1.5, #566). */
export interface ScenarioReplaceRequest {
  scenarioId: string;
  nodeId: string;
  onBusy?: CallResponseSpec;
}

/** How an answer the scenario gave ended; always resolves. */
export type ScenarioAnswerSettlement =
  { delivered: true } | { delivered: false; reason: string };

/**
 * The CALL a scenario run owns (schema 1.5, #566): what arrived, and the one
 * way to answer it. Branch-scoped: the executor keeps it in the flow of the
 * branch that reached the `csmsCallTrigger`.
 */
export interface ScenarioCallExchange {
  readonly action: string;
  readonly messageId: string;
  readonly payload: unknown;
  /** Answer the CALL and wait until the answer settled. Throws when the
   *  response breaks the action's schema (unless `skipValidation`). */
  answer(
    spec: CallResponseSpec & { skipValidation?: boolean },
  ): Promise<ScenarioAnswerSettlement>;
}

export interface ScenarioExecutorCallbacks {
  onStatusChange?: (
    status: OCPPStatus,
    options?: { readonly allowInvalidTransition?: boolean },
  ) => Promise<void>;
  /**
   * Returns the domain's `StartTransactionOutcome` (issue #181) so the
   * executor can distinguish a denied local-authorize gate from a real
   * start without a thrown error — `void` return remains valid for any
   * implementation that doesn't need to report an outcome.
   */
  /**
   * The idTag to present when a transaction node names none (#299).
   *
   * A callback rather than a reference to the charge point: the executor is
   * deliberately given behaviour, not the domain object, and it has no
   * connector of its own — the runtime that wires this closes over the
   * connector it is bound to. Returning `null` means "no pool", and the node
   * falls back to the historical default tag.
   */
  onResolveIdTag?: () => string | null;
  onStartTransaction?: (
    tagId: string,
    batteryCapacityKwh?: number,
    initialSoc?: number,
    options?: StartTransactionOptions,
  ) => Promise<StartTransactionOutcome | void>;
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
  // #240: the trigger waits below (remote start / stop, CSMS call,
  // connection, status, reservation) take no timeout: the executor enforces
  // the node's timeout itself, so an operator can extend or retry it.
  onWaitForRemoteStart?: () => Promise<string | RemoteStartDetails>; // Returns tagId from RemoteStartTransaction
  /**
   * Block until CSMS sends RemoteStopTransaction.req for the currently
   * active transaction. Returns the requested transactionId so callers
   * can sanity-check it.
   * Implementations register a scenario-side handler so the default
   * RemoteStopTransactionHandler delegates instead of stopping the
   * transaction itself.
   */
  /** Resolves with `{ transactionId, reason }` so the next Transaction
   *  Stop node can pass the CSMS-supplied reason (defaults to "Remote")
   *  through to StopTransaction.req. */
  onWaitForRemoteStop?: () => Promise<{
    transactionId: number;
    reason: string;
    triggerReason?: TransactionStopTriggerReason;
  }>;
  /** Issue #110: park until the CSMS sends the given incoming CALL
   *  action. Resolves with the request payload for logging. */
  onWaitForCsmsCall?: (
    action: string,
    payload?: Record<string, unknown>,
    /** Schema 1.5: present for `behavior: "replace"`; the wait then also
     *  resolves with the exchange the scenario now owns. */
    replace?: ScenarioReplaceRequest,
  ) => Promise<{
    action: string;
    payload: unknown;
    exchange?: ScenarioCallExchange;
  }>;
  /** Schema 1.5: the run ended (finished, failed or stopped). Release what it
   *  armed and answer the CALLs it still owns with CALLERROR `InternalError`. */
  onRunEnded?: () => void;
  /** Schema 1.5: select the behavior loaded on the station with this id;
   *  throws if there is none. Schema 1.6: `params` and `mode: "disable"`. */
  onUseBehavior?: (
    behaviorId: string,
    nodeId: string,
    options?: { mode: "use" | "disable"; params?: Record<string, unknown> },
  ) => void;
  /** Issue #240: park until the WebSocket reaches `event`. Level-triggered;
   *  never rejects on disconnect. */
  onWaitForConnection?: (event: "connected" | "disconnected") => Promise<void>;
  onWaitForStatus?: (targetStatus: OCPPStatus) => Promise<void>; // Waits for status change
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
  onWaitForReservation?: () => Promise<number>; // Returns reservationId from ReserveNow request
  /** Apply (merge) a partial EVSettings onto the target connector. */
  onSetEVSettings?: (settings: Partial<EVSettings>) => Promise<void> | void;
  /** Read the current EVSettings; used by meterValue stopMode="evSettings". */
  onGetEVSettings?: () => EVSettings | null;
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void; // Progress updates for long-running nodes
  onError?: (error: Error) => void;
  /** #240: an operator extended, retried or continued a parked wait. */
  onWaitIntervention?: (intervention: ScenarioWaitIntervention) => void;
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
  /** Issue #110: arm a one-shot `{ status }` response override for the
   *  next incoming CALL of the given action. */
  onArmResponseOverride?: (action: string, status: string) => void;
  /** #1090: arm a response override of any mode (a CALLERROR, a raw payload
   *  or frame, a CALLRESULTERROR, a delay, silence), once or repeatedly. */
  onSetResponseOverride?: (request: ResponseOverrideRequest) => void;
  /** Issue #110: clear an armed response override. Called when a scenario
   *  run ends (both normal completion and stop()) to clean up any overrides
   *  armed during the run. */
  onClearResponseOverride?: (action: string) => void;
  /** Issue #247: set a persistent inbound call policy for the given action. */
  onSetInboundPolicy?: (
    action: string,
    policy: "callerror" | "ignore",
    errorCode?: string,
    errorDescription?: string,
  ) => void;
  /** Issue #247: clear the inbound call policy for the given action (or all
   *  if action is omitted). Called when a scenario run ends to clean up. */
  onClearInboundPolicy?: (action?: string) => void;
  /** Issue #247 Phase 3: set certificate quirks (merge with existing). */
  onSetCertificateQuirks?: (
    quirks: Partial<{
      csrKeyAlgorithm?: "ECDSA" | "RSA";
      csrPemLineEndings?: "lf" | "crlf";
      requiredCertificateSignatureAlgorithms?: string[];
      hiddenConfigurationKeys?: string[];
    }>,
  ) => void;
  /** Issue #247 Phase 3: clear all certificate quirks. Called when a scenario
   *  run ends to clean up any quirks armed during the run. */
  onClearCertificateQuirks?: () => void;
  /** §5.3: apply a Configuration key change locally. */
  onConfigSet?: (key: string, value: string) => void;
  /** #389: send an expert OCPP call; resolves with the CSMS's answer and
   *  rejects when the call is refused or gets no answer. */
  onSendOcppCall?: (request: OcppCallRequest) => Promise<OcppCallOutcome>;
  /** Schema 1.6 (#654): send a status notification (`notify` node). */
  onNotify?: (kind: NotifyKind, status: string, requestId?: number) => void;
  /**
   * Schema 1.6 (#654): the read-only `$from` roots that live on the station.
   * `charger` is the station, `connector` the connector the scenario is bound
   * to (undefined for a station-level scenario). A plain JSON object.
   */
  onReadStation?: (root: "charger" | "connector") => unknown;
  /** §4.3: send CP-initiated DataTransfer.req. */
  onSendDataTransfer?: (
    vendorId: string,
    messageId?: string,
    data?: string,
  ) => void;
  /**
   * Awaited once the flow has returned, before the run is marked completed:
   * resolves when the frames the last nodes caused have gone out and been
   * answered, so the run's transcript (and its assertions) see them. Ignored
   * when the run is stopped meanwhile.
   */
  onRunEnding?: () => Promise<void>;
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

  /** #240: an operator extended, retried or continued a parked wait. */
  "wait.intervention": ScenarioWaitIntervention & { scenarioId: string };

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
