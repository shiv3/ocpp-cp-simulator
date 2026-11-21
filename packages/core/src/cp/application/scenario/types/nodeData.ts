import type { ScenarioMode } from "@ocpp-cp-simulator/contracts/scenario";
import type { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { CurvePoint } from "../../../domain/connector/MeterValueCurve";
import type {
  IdTokenTypeName,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
} from "../../../domain/connector/Transaction";
import type { OcppCallRequest } from "../../../domain/types/OcppCall";
/**
 * Scenario execution mode
 */
export type { ScenarioMode };

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
  // Issue #110 certification scenarios: park until the CSMS sends a given
  // incoming CALL (Reset, GetConfiguration, SendLocalList, …). The CP
  // core handler still runs; this node only observes the arrival.
  CSMS_CALL_TRIGGER = "csmsCallTrigger",
  // Issue #110: arm a one-shot response override for the next incoming
  // CALL of a given action (e.g. RemoteStartTransaction → Rejected for
  // TC_026). The armed `{ status }` replaces the handler's response.
  RESPONSE_OVERRIDE = "responseOverride",
  // Issue #247: set a persistent inbound call policy for an action
  // (callerror or ignore). Policies survive reconnects until explicitly
  // cleared, unlike responseOverride which is one-shot.
  INBOUND_POLICY = "inboundPolicy",
  // Issue #247 Phase 3: set or clear certificate quirks (ChargePoint
  // domain-specific behaviors like CSR key algorithm, PEM line endings,
  // signature algorithm requirements, hidden configuration keys). Used to
  // emulate certification-tool behaviors (e.g., OCTT strictness).
  CERT_QUIRKS = "certQuirks",
  // Issue #240: park until the WebSocket connects or disconnects.
  // Level-triggered (already in the target state → resolve immediately)
  // and observe-only — causing disconnects is network simulation (#239).
  CONNECTION_TRIGGER = "connectionTrigger",
  // Issue #389: expert OCPP call — any station-initiated CALL of the
  // station's OCPP-J version with an authored payload. Waits for the answer
  // and logs it; see ChargePoint.sendOcppCall.
  OCPP_CALL = "ocppCall",
  // Schema 1.5 (#566): answer the CSMS CALL a `csmsCallTrigger` with
  // `behavior: "replace"` took over. Kind result / error / none.
  CALL_RESPONSE = "callResponse",
  // Schema 1.5 (#566): select a behavior loaded on the station by id.
  USE_BEHAVIOR = "useBehavior",
  // Schema 1.6 (#654, step 3): the bounded set of new nodes. A verb the
  // station already has on `ctx` (`ctx.notify`, `ctx.state`) or one of the
  // listed decision nodes; see docs/concepts/scenario-format.md, "What the
  // format will not do".
  /** Send a status notification (`ctx.notify`), fire-and-forget. */
  NOTIFY = "notify",
  /** Branch on the equality of a value with JSON constants. */
  SWITCH = "switch",
  /** Branch on a seeded, weighted draw. */
  CHOICE = "choice",
  /** Store a JSON value in the run's state, read back through `$from`. */
  SET_STATE = "setState",
}

/**
 * Schema 1.9 flow-control nodes: fork a branch into parallel branches and
 * meet them again. Kept apart from {@link ScenarioNodeType}, which lists the
 * steps the console editor offers (its palettes and forms are keyed by it);
 * the executor, the graph rules and the schema know both.
 */
export enum ScenarioFlowNodeType {
  /** Run every outgoing ordinary edge as its own branch. */
  PARALLEL = "parallel",
  /** Where the branches of a `parallel` meet; `mode` "all" (default) or "any". */
  JOIN = "join",
}

/** A node type the executor runs: a step or a flow-control node. */
export type AnyScenarioNodeType = ScenarioNodeType | ScenarioFlowNodeType;

/**
 * Base node data
 */
export type BaseNodeData = {
  label: string;
  description?: string;
};

/**
 * Status Change Node Data
 */
export type StatusChangeNodeData = BaseNodeData & {
  status: OCPPStatus;
  /**
   * Schema 1.11 (#618): send the StatusNotification even when the charge
   * point's capability profile enforces the OCPP 1.6 §4.9 transition table
   * (`statusTransitions: "enforce"`) and this change is not in it. Absent or
   * false: the profile decides.
   */
  allowInvalidTransition?: boolean;
};

/**
 * Transaction Node Data
 */
export type TransactionNodeData = BaseNodeData & {
  action: "start" | "stop";
  tagId?: string; // Only for start
  batteryCapacityKwh?: number; // Battery capacity of the EV in kWh (e.g., 40, 60, 100)
  initialSoc?: number; // Initial State of Charge percentage (0-100)
  /** Optional OCPP §6.21 stop reason for action="stop" (e.g.
   *  "EVDisconnected" for TC_005, "PowerLoss"). A reason captured by a
   *  preceding RemoteStopTrigger node still wins. Issue #110. */
  stopReason?: string;
  /** OCPP 2.x `IdToken.type` of the start's Authorize and TransactionEvents
   *  (#599); `ISO14443` when absent. Ignored on 1.6. Only for start. */
  idTokenType?: IdTokenTypeName;
};

export interface RemoteStartDetails {
  tagId: string;
  remoteStartId?: number;
  /** The CSMS's `idToken.type` of a 2.x RequestStartTransaction (#599). */
  idTokenType?: IdTokenTypeName;
}

export interface StartTransactionOptions {
  triggerReason?: TransactionStartTriggerReason;
  remoteStartId?: number;
  idTokenType?: IdTokenTypeName;
}

export interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
}

/**
 * MeterValue Node Data
 */
export type MeterValueNodeData = BaseNodeData & {
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
};

/**
 * Delay Node Data
 */
export type DelayNodeData = BaseNodeData & {
  delaySeconds: number;
  /** Schema 1.6 (#654): ISO-8601 instant on the station's clock. The node
   *  waits until then or for `delaySeconds`, whichever is longer; an instant
   *  that has passed adds nothing. */
  until?: string;
  /** Schema 1.6 (#654): add a seeded draw of 0 to `jitterSeconds` (millisecond
   *  resolution) to the wait. The same seed gives the same wait. */
  jitterSeconds?: number;
};

/**
 * Notification Node Data
 */
export type NotificationNodeData = BaseNodeData & {
  messageType: string; // e.g., "Authorize", "DataTransfer", etc.
  payload: Record<string, unknown>;
};

/**
 * Connector Plug Node Data
 */
export type ConnectorPlugNodeData = BaseNodeData & {
  action: "plugin" | "plugout";
};

/**
 * Remote Start Trigger Node Data
 * This node waits for a RemoteStartTransaction request from the central system
 */
export type RemoteStartTriggerNodeData = BaseNodeData & {
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
};

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
export type RemoteStopTriggerNodeData = BaseNodeData & {
  /** Optional timeout in seconds. 0 (default) = wait forever. */
  timeout?: number;
};

/**
 * CSMS Call Trigger Node Data — generic counterpart of the per-action
 * trigger nodes. Blocks the scenario until the CSMS sends any CALL whose
 * action matches `action`. The CP core handler for that action still runs
 * (GetConfiguration still answers from the store, Reset still reboots…);
 * this node only synchronizes the scenario with the arrival. Issue #110.
 */
export type CsmsCallTriggerNodeData = BaseNodeData & {
  /** Action name of the incoming CSMS call to wait for, in the 1.6 or the
   *  2.0.1 spelling — a 2.0.1 station matches `RequestStartTransaction`
   *  against `RemoteStartTransaction` too (#349). */
  action: string;
  /** Optional timeout in seconds. 0 (default) = wait forever. */
  timeout?: number;
  /** #240: optional payload condition. The wait only releases on an
   *  incoming CALL of `action` whose payload deep-partially matches this
   *  subset (see packages/core/src/scenario/deepPartialMatch.ts). Non-matching frames
   *  are not consumed — the node keeps waiting. Absent = any payload. */
  payload?: Record<string, unknown>;
  /** Schema 1.5 (#566). `observe` (default, as before): the station's own
   *  behavior answers the CALL and the node only waits for its arrival.
   *  `replace`: the scenario owns the CALL; nothing answers it until a
   *  `callResponse` node does, and the default behavior does not run. */
  behavior?: "observe" | "replace";
  /** Schema 1.5: what a second matching CALL gets while the first is still
   *  unanswered (only with `behavior: "replace"`). Default: CALLERROR
   *  `GenericError`. */
  onBusy?: CallResponseSpec;
};

/**
 * How a scenario answers a CALL it owns (schema 1.5, #566): a CALLRESULT with
 * `payload`, a CALLERROR with `errorCode` / `errorDescription`, or silence.
 * A `payload` may hold `{ "$from": "call.payload.requestId" }` as a whole
 * value, resolved against the exchange of the branch.
 */
export type CallResponseSpec = {
  /** `accepted` / `rejected` (schema 1.6, #654): the version-neutral answer of
   *  the CALL's action, `ctx.accepted(action)` / `ctx.rejected(action)`; they
   *  take no `payload`. */
  kind: "result" | "error" | "none" | "accepted" | "rejected";
  payload?: Record<string, unknown>;
  errorCode?: string;
  errorDescription?: string;
};

/**
 * Call Response Node Data (schema 1.5, #566): answers the CALL taken by the
 * nearest `csmsCallTrigger` (`behavior: "replace"`) of this branch, and waits
 * until the answer settled on the wire. Fails the run if the branch holds no
 * CALL or the answer was not delivered.
 */
export type CallResponseNodeData = BaseNodeData &
  CallResponseSpec & {
    /** Send `payload` without checking it against the response schema. */
    skipValidation?: boolean;
  };

/** The kinds of status notification a `notify` node sends. */
export const NOTIFY_KINDS = [
  "firmwareStatus",
  "signedFirmwareStatus",
  "logStatus",
  "diagnosticsStatus",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** A whole value read from a root: `{ "$from": "state.key" }` (schema 1.5, 1.6). */
export type FromReference = { $from: string };

/**
 * Notify Node Data (schema 1.6, #654): `ctx.notify` as a node. Sends the
 * status notification and goes on without waiting for the CSMS. `requestId`
 * may be a `$from` reference; `signedFirmwareStatus` needs one.
 */
export type NotifyNodeData = BaseNodeData & {
  kind: NotifyKind;
  status: string;
  requestId?: number | FromReference;
};

/**
 * Switch Node Data (schema 1.6, #654): the run goes on along the edge whose
 * `sourceHandle` is `case-<n>` for the first case equal to `value`, else along
 * `default`; a branch with no such edge ends. Equality is JSON equality: it
 * never converts (`1` is not `"1"`). `value` is a constant or a `$from`.
 */
export type SwitchNodeData = BaseNodeData & {
  value: unknown;
  cases: unknown[];
};

/**
 * Choice Node Data (schema 1.6, #654): a seeded, weighted draw among
 * `options`; the run goes on along the edge whose `sourceHandle` is
 * `option-<n>`. `weight` defaults to 1. The same seed gives the same draw.
 */
export type ChoiceNodeData = BaseNodeData & {
  options: Array<{ weight?: number; label?: string }>;
};

/**
 * Set State Node Data (schema 1.6, #654): stores `value` (JSON; a whole value
 * may be a `$from`) under `key` in the state of this run, which `$from`
 * `state.<key>` reads back. The state lives for the run, shared by its
 * parallel branches, and is not persisted.
 */
export type SetStateNodeData = BaseNodeData & {
  key: string;
  value: unknown;
};

/** Parallel Node Data (schema 1.9): a label only. */
export type ParallelNodeData = BaseNodeData;

/**
 * Join Node Data (schema 1.9). `all` (the default; any other value too):
 * go on once every branch of the parallel execution arrived or ended;
 * `any`: go on at the first arrival and cancel the other branches.
 */
export type JoinNodeData = BaseNodeData & {
  mode?: "all" | "any";
};

/** Use Behavior Node Data (schema 1.5, #566; `params` and `mode` 1.6, #654):
 *  data only, the id of a behavior (loaded on the station, or a built-in
 *  `default.*`). Fails the run if none has that id.
 *
 *  `mode: "use"` (the default) selects it; `params` are its knobs for the run,
 *  merged over the station's selection and the behavior's defaults, validated
 *  against its params schema, and refused (the run fails) when they do not
 *  fit. `mode: "disable"` answers each of its CALLs with the version's
 *  `accepted` answer and nothing after, for the run; it takes no params. */
export type UseBehaviorNodeData = BaseNodeData & {
  behaviorId: string;
  mode?: "use" | "disable";
  params?: Record<string, unknown>;
};

/**
 * Status Trigger Node Data
 * This node waits for the connector status to change to a specific state
 */
export type StatusTriggerNodeData = BaseNodeData & {
  targetStatus: OCPPStatus; // Status to wait for
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
};

/**
 * Reserve Now Node Data
 * This node creates a reservation on the connector
 */
export type ReserveNowNodeData = BaseNodeData & {
  expiryMinutes: number; // How long the reservation is valid (in minutes)
  idTag: string; // ID tag that can use the reservation
  parentIdTag?: string; // Optional parent ID tag
  reservationId?: number; // Optional reservation ID (auto-generated if not provided)
};

/**
 * Cancel Reservation Node Data
 * This node cancels an existing reservation
 */
export type CancelReservationNodeData = BaseNodeData & {
  reservationId: number; // ID of the reservation to cancel
};

/**
 * Reservation Trigger Node Data
 * This node waits for a ReserveNow request from the central system
 */
export type ReservationTriggerNodeData = BaseNodeData & {
  timeout?: number; // Optional timeout in seconds (0 = no timeout)
};

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
export type StartNodeData = BaseNodeData & {
  triggerOn?: "connect" | "status";
  targetStatus?: OCPPStatus;
};

/**
 * Status Notification Node Data — sends a full StatusNotification.req with
 * arbitrary errorCode / info / vendorErrorCode so scenarios can drive the
 * Faulted-with-context paths CSMS implementations care about (§4.9).
 *
 * Setting `connectorId` to 0 targets the CP main controller, in which
 * case `status` must be Available / Unavailable / Faulted (§7.7).
 */
export type StatusNotificationNodeData = BaseNodeData & {
  status: OCPPStatus;
  errorCode?: string; // ChargePointErrorCode
  info?: string;
  vendorErrorCode?: string;
  vendorId?: string;
  /** Override which connector this targets. Defaults to the scenario's
   *  bound connector (or 0 for chargePoint-targeted scenarios). */
  connectorId?: number;
};

/**
 * Unlock Outcome Node Data — sets the connector's next UnlockConnector.req
 * response (§5.18 / §7.46). Does not emit any CSMS-bound message itself;
 * it's a pre-arm for the upcoming Central System call.
 */
export type UnlockOutcomeNodeData = BaseNodeData & {
  outcome: "Unlocked" | "UnlockFailed" | "NotSupported";
};

/**
 * Response Override Node Data — arms a one-shot canned `{ status }`
 * response on the charge point for the next incoming CALL whose action
 * matches. Non-blocking pre-arm, like unlockOutcome. Issue #110.
 *
 * Overrides are armed charge-point-wide (not connector-scoped) and consumed
 * once per action, so they're intended for single-connector certification
 * scenarios rather than multi-connector charge points.
 */
export type ResponseOverrideNodeData = BaseNodeData & {
  /** Action whose next incoming call gets the canned response, in the 1.6
   *  or the 2.0.1 spelling (#349). */
  action: string;
  /** Status string returned as `{ status }` for that call (mode `status`, the
   *  default). */
  status?: string;
  /** How the call is answered; default `status`. See
   *  `ResponseOverrideSpec` (#1090). */
  mode?:
    | "status"
    | "callError"
    | "callResult"
    | "raw"
    | "callResultError"
    | "delay"
    | "noAnswer";
  /** `callError` / `callResultError`. */
  errorCode?: string;
  errorDescription?: string;
  errorDetails?: Record<string, unknown>;
  /** `callResult`: the CALLRESULT payload, written as given. */
  payload?: unknown;
  /** `raw`: the text frame written as the answer. */
  frame?: string;
  /** `delay`, or the hold before any other answer, in milliseconds. */
  delayMs?: number;
  /** How many CALLs the override answers (default 1). */
  times?: number;
  /** Answer every CALL of the action until the run ends. */
  persistent?: boolean;
};

/**
 * Inbound Policy Node Data — sets a persistent per-action policy for
 * incoming CSMS→CP calls. Issue #247.
 *
 * Policies are sticky and survive reconnects (unlike responseOverride which
 * is one-shot). Three modes:
 * - "answer": clear any existing policy for the action (resume normal handling).
 * - "callerror": reply with CALLERROR(errorCode, errorDescription).
 * - "ignore": send no response (caller's timeout fires).
 */
export type InboundPolicyNodeData = BaseNodeData & {
  /** Action to arm a policy for, in the 1.6 or the 2.0.1 spelling (#349). */
  action: string;
  /** Policy mode: "answer" to clear, "callerror" to reject, "ignore" to silence. */
  policy: "answer" | "callerror" | "ignore";
  /** Error code for policy === "callerror"; must be a valid OCPPErrorCodeV16. */
  errorCode?: string;
  /** Optional error description for policy === "callerror". */
  errorDescription?: string;
};

/**
 * Certificate Quirks Node Data — sets or clears ChargePoint domain-specific
 * certificate behaviors (CSR key algorithm, PEM line endings, required
 * signature algorithms, hidden configuration keys). Issue #247 Phase 3.
 *
 * Two modes:
 * - "set": apply quirks from an optional preset and/or explicit fields.
 * - "clear": clear all quirks (resume normal behavior).
 *
 * Presets (e.g., "octt") encode certification-tool behaviors. Explicit
 * fields override preset values. Quirks are tracked and cleared when the
 * scenario completes or stops (same lifecycle as inboundPolicy).
 */
export type CertQuirksNodeData = BaseNodeData & {
  /** Mode: "set" to apply quirks, "clear" to remove them. */
  mode: "set" | "clear";
  /** Optional preset name; only meaningful when mode === "set". */
  preset?: "octt";
  /** CSR key algorithm (only for mode="set" and optional). */
  csrKeyAlgorithm?: "ECDSA" | "RSA";
  /** CSR PEM line endings (only for mode="set" and optional). */
  csrPemLineEndings?: "lf" | "crlf";
  /** Required certificate signature algorithms (only for mode="set" and optional). */
  requiredCertificateSignatureAlgorithms?: string[];
  /** Hidden configuration keys (only for mode="set" and optional). */
  hiddenConfigurationKeys?: string[];
};

/**
 * Config Set Node Data — applies a ChangeConfiguration locally (without
 * round-tripping through CSMS). Useful for tightening
 * MeterValueSampleInterval / changing MeterValuesSampledData mid-scenario.
 */
export type ConfigSetNodeData = BaseNodeData & {
  key: string;
  value: string; // string form, parsed by ConfigurationStore per the key's type
};

/**
 * Data Transfer Node Data — issues a CP-initiated DataTransfer.req
 * (§4.3). Vendor / message id / payload are all user-controlled.
 */
export type DataTransferNodeData = BaseNodeData & {
  vendorId: string;
  messageId?: string;
  data?: string;
};

/**
 * OCPP Call Node Data (#389) — an expert OCPP call: the action, the payload
 * as authored, and the two per-call expert switches. A CALLERROR answer is
 * logged and the flow goes on; a refused call or no answer fails the run.
 */
export type OcppCallNodeData = BaseNodeData &
  OcppCallRequest & {
    /** `send` (#1096): an OCPP 2.1 SEND (message type 6, e.g.
     *  NotifyPeriodicEventStream), unconfirmed: nothing is awaited and no
     *  answer is recorded for `$from: "response"`. Default `call`. */
    messageType?: "call" | "send";
  };

/**
 * Connection Trigger Node Data — waits for the charge point's WebSocket to
 * reach `event`. Level-triggered like statusTrigger: if the connection is
 * already in the target state the node resolves immediately. Unlike every
 * other wait, this node does NOT fail on disconnect — surviving the
 * disconnected span is its purpose (a "connected" wait spanning a reconnect
 * is the canonical use). Issue #240.
 */
export type ConnectionTriggerNodeData = BaseNodeData & {
  event: "connected" | "disconnected";
  /** Optional timeout in seconds. 0 (default) = wait forever. */
  timeout?: number;
};

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
  | CsmsCallTriggerNodeData
  | StatusTriggerNodeData
  | ReserveNowNodeData
  | CancelReservationNodeData
  | ReservationTriggerNodeData
  | StatusNotificationNodeData
  | UnlockOutcomeNodeData
  | ResponseOverrideNodeData
  | InboundPolicyNodeData
  | CertQuirksNodeData
  | ConfigSetNodeData
  | DataTransferNodeData
  | OcppCallNodeData
  | CallResponseNodeData
  | UseBehaviorNodeData
  | NotifyNodeData
  | SwitchNodeData
  | ChoiceNodeData
  | SetStateNodeData
  | JoinNodeData
  | StartNodeData
  | ConnectionTriggerNodeData
  | BaseNodeData;
