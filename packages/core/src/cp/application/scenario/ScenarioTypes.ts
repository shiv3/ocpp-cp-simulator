import type { Node, Edge } from "@xyflow/react";
import type { ScenarioMode } from "@ocpp-cp-simulator/contracts/scenario";
import type { OCPPStatus } from "../../domain/types/OcppTypes";
import type { CurvePoint } from "../../domain/connector/MeterValueCurve";
import type { EVSettings } from "../../domain/connector/EVSettings";
import type {
  IdTokenTypeName,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
} from "../../domain/connector/Transaction";
import type { StartTransactionOutcome } from "../../domain/charge-point/ChargePoint";
import type {
  OcppCallOutcome,
  OcppCallRequest,
} from "../../domain/types/OcppCall";

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
  /** Status string returned as `{ status }` for that call. */
  status: string;
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
export type OcppCallNodeData = BaseNodeData & OcppCallRequest;

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
  | StartNodeData
  | ConnectionTriggerNodeData
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
 * Scenario file schema version (issue #214), mirroring the `"major.minor"`
 * string convention and versioning rules of {@link
 * ../../../../../trace/src/OcppTraceRecord.ts | OCPP_TRACE_SCHEMA_VERSION}: additive
 * optional fields bump the minor version, consumers MUST ignore unknown
 * fields, and a semantic change to an existing field is a new major version.
 * See `packages/core/schema/scenario.schema.json` (Draft 2020-12) and
 * `docs/concepts/scenario-format.md`.
 */
export const SCENARIO_SCHEMA_VERSION = "1.7";

/** Where a recorded scenario came from (schema 1.6, #654 step 2). */
export interface ScenarioRecordedFrom {
  /** The id of the behavior that ran, e.g. `default.firmware`. */
  behaviorId: string;
  /** The build that ran it: git commit when known, else the version label. */
  commit: string;
  /** The seed of the run: the same seed records the same scenario. */
  seed: string | number;
  /** The simulator version that recorded it. */
  version: string;
}

/**
 * Scenario definition
 */
export interface ScenarioDefinition {
  /** Scenario schema version, e.g. {@link SCENARIO_SCHEMA_VERSION}. Optional:
   *  absent on files exported before issue #214 (they remain valid — schema
   *  conformance is advisory, never a hard gate). */
  schemaVersion?: string;
  id: string;
  /**
   * The built-in template this scenario was instantiated from, when it was.
   * Set by `templateFromJson`'s `createScenario`; absent on hand-authored
   * scenarios and on instances persisted by builds before this field existed.
   *
   * Informational on the daemon since #338: its template instances have the
   * stable id `<templateId>-c<connector>`, so "the same template on the same
   * connector" is the same key and a reload replaces it. Browser instances
   * still embed `Date.now()` in their id.
   */
  templateId?: string;
  /**
   * The web console's Library scenario this per-connector copy came from
   * (schema v1.4). Set when a connector is assigned a library scenario, so
   * the Library can tell which connectors use it and re-push an edit to
   * them. Absent on library entries themselves and on scenarios loaded by
   * hand (CLI, MCP, a JSON import onto a connector).
   */
  libraryId?: string;
  /**
   * Set on a scenario made by recording a behavior run (schema 1.6, #654
   * step 2), so it is never mistaken for the default behavior it came from.
   * Informational: the runtime ignores it.
   */
  recordedFrom?: ScenarioRecordedFrom;
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

  /**
   * #179 Phase 2b: declarative pass/fail assertions checked against the
   * captured OCPP wire transcript once the run ends. Optional — a scenario
   * with no assertions produces a SKIPPED verdict and runs exactly as
   * before (no behavior change).
   */
  assertions?: AssertionSpec[];

  /**
   * Promotes warning-severity assertion failures to run failures (strict
   * mode, #247). Default false; a per-run `strict` option overrides it.
   */
  strictCompatibility?: boolean;
}

/**
 * #179 Phase 2b: the kind of check an {@link AssertionSpec} performs against
 * the captured OCPP wire transcript of one scenario run.
 */
export type AssertionType =
  | "ocpp_sent"
  | "ocpp_received"
  | "ocpp_absent"
  | "response_status"
  | "idtag_info_status"
  | "payload_match"
  | "message_order"
  | "message_after"
  | "state_transition"
  | "no_unexpected";

/**
 * How an assertion failure affects the run verdict (#247). "failure"
 * (default): normative OCPP conformance check; failing it fails the run.
 * "warning": compatibility observation (e.g. OCTT quirks); failing it yields
 * a compatibility WARNING, promoted to FAIL only in strict mode.
 */
export type AssertionSeverity = "failure" | "warning";

/**
 * Declarative assertion attached to a {@link ScenarioDefinition}. Evaluated
 * against the run's captured {@link Frame} transcript by
 * `evaluateAssertions` (packages/core/src/cp/application/verification/ScenarioAssertions.ts)
 * once the run ends. Field usage varies by `type` — see that module's
 * mapping doc.
 */
export interface AssertionSpec {
  /** Stable identifier; echoed on the corresponding {@link AssertionResult}. */
  id: string;
  description?: string;
  type: AssertionType;
  /** OCPP action for frame-based assertion types. */
  action?: string;
  direction?: "sent" | "received";
  /** Expected status for response_status / idtag_info_status. */
  status?: string;
  /** Nth (0-indexed) occurrence of `action`. Default 0. */
  occurrence?: number;
  /** Partial subset match against the matched CALL's payload (payload_match). */
  payload?: Record<string, unknown>;
  /** Expected connector status for state_transition. */
  targetStatus?: string;
  /** Set of actions that must not appear as a sent CALL (no_unexpected). */
  actions?: string[];
  /** Reference frame matcher for message_order / message_after. */
  before?: { action: string; direction?: "sent" | "received" };
  after?: { action: string; direction?: "sent" | "received" };
  /** How an assertion failure affects the run verdict. Default "failure". */
  severity?: AssertionSeverity;
}

/** Outcome of evaluating one {@link AssertionSpec} against a run's transcript. */
export type AssertionStatus = "passed" | "failed" | "skipped" | "blocked";

export interface AssertionResult {
  id: string;
  type: AssertionType;
  status: AssertionStatus;
  description: string;
  /** Explanation of what was/wasn't found; set on failure. */
  detail?: string;
  /** How this assertion failure affects the verdict. */
  severity: AssertionSeverity;
  /**
   * #240: transcript frames this result is about — the `seq` (capture-order
   * index) of each frame that satisfied the check (on pass) or triggered the
   * failure (e.g. the unexpected CALL for `ocpp_absent`). Join against
   * {@link ScenarioRunResult.transcript}'s `seq` to point a failed assertion
   * at the relevant messages. Absent when no frame is relevant (e.g. a
   * "never sent" miss, or a malformed spec).
   */
  frameRefs?: number[];
}

/** Overall pass/fail verdict for one scenario run, rolled up from its
 *  {@link AssertionResult}s (see `computeVerdict`). */
export type ScenarioVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

/** Compatibility-only verdict for warning-severity assertions (see `computeVerdictSummary`). */
export type CompatibilityVerdict = "PASS" | "WARNING" | "FAIL" | "SKIPPED";

/**
 * Minimal runtime shape check for a value read from an operator-supplied
 * file (`load_scenario`/`run_scenario_file --file <path>`). The daemon
 * accepts any path the caller names, so without this guard `JSON.parse`
 * output was accepted via a bare `as ScenarioDefinition` cast — any
 * readable JSON file on the host, not just an actual scenario, would be
 * stored and become retrievable through `get_scenario`/`list_scenarios`.
 * This only checks the fields required to identify a scenario; full
 * per-node validation still happens downstream when the scenario runs.
 */
export function isScenarioDefinitionShape(
  value: unknown,
): value is ScenarioDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    (v.targetType === "chargePoint" || v.targetType === "connector") &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges)
  );
}

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
  onStatusChange?: (status: OCPPStatus) => Promise<void>;
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

/** Incoming CSMS→CP calls a csmsCallTrigger node can wait for. */
export const CSMS_CALL_TRIGGER_ACTIONS = [
  "Reset",
  "GetConfiguration",
  "ChangeConfiguration",
  "ClearCache",
  "GetLocalListVersion",
  "SendLocalList",
  "TriggerMessage",
  "SetChargingProfile",
  "ClearChargingProfile",
  "GetCompositeSchedule",
  "UpdateFirmware",
  "GetDiagnostics",
  "ReserveNow",
  "CancelReservation",
  "UnlockConnector",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "DataTransfer",
  "ChangeAvailability",
] as const;

/** Actions a responseOverride node may target: their CALLRESULT payload
 *  is exactly `{ status }`, so a canned status is schema-valid. */
export const RESPONSE_OVERRIDE_ACTIONS = [
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "TriggerMessage",
  "ReserveNow",
  "CancelReservation",
  "SendLocalList",
  "ChangeConfiguration",
  "ClearCache",
  "SetChargingProfile",
  "ClearChargingProfile",
  "ChangeAvailability",
] as const;

/** Statuses valid for each responseOverride action's `{ status }`
 *  CALLRESULT, per this repo's generated OCPP 1.6 response types
 *  (packages/ocpp/src/v16/types/*-response.ts). Keeps editor UI from offering
 *  schema-invalid action/status combinations. */
export const RESPONSE_OVERRIDE_STATUSES: Record<
  (typeof RESPONSE_OVERRIDE_ACTIONS)[number],
  readonly string[]
> = {
  RemoteStartTransaction: ["Accepted", "Rejected"],
  RemoteStopTransaction: ["Accepted", "Rejected"],
  TriggerMessage: ["Accepted", "Rejected", "NotImplemented"],
  ReserveNow: ["Accepted", "Faulted", "Occupied", "Rejected", "Unavailable"],
  CancelReservation: ["Accepted", "Rejected"],
  SendLocalList: ["Accepted", "Failed", "NotSupported", "VersionMismatch"],
  ChangeConfiguration: [
    "Accepted",
    "Rejected",
    "RebootRequired",
    "NotSupported",
  ],
  ClearCache: ["Accepted", "Rejected"],
  SetChargingProfile: ["Accepted", "Rejected", "NotSupported"],
  ClearChargingProfile: ["Accepted", "Unknown"],
  ChangeAvailability: ["Accepted", "Rejected", "Scheduled"],
};

/** Actions a inboundPolicy node may target. Uses the full set of
 *  inbound CSMS→CP actions (like csmsCallTrigger), since policies can
 *  apply to any incoming call — not just those with `{ status }` responses. */
export const INBOUND_POLICY_ACTIONS = CSMS_CALL_TRIGGER_ACTIONS;

/** Valid OCPP 1.6 error codes for inboundPolicy callerror mode. */
export const INBOUND_POLICY_ERROR_CODES = [
  "NotImplemented",
  "NotSupported",
  "InternalError",
  "ProtocolError",
  "SecurityError",
  "FormationViolation",
  "PropertyConstraintViolation",
  "OccurenceConstraintViolation",
  "TypeConstraintViolation",
  "GenericError",
] as const;

/** Presets for certQuirks node; currently "octt" encodes legacy OCTT
 *  strictness (RSA CSR, CRLF PEM, RSASSA-PKCS1-v1_5 only, hide CpoName). */
export const CERT_QUIRKS_PRESETS = ["octt"] as const;

/** The OCTT preset expansion: legacy SHA256withRSA-only acceptance
 *  (reject RSA-PSS), RSA CSR, CRLF PEM, no CpoName reference.
 *  See steve-community/steve#2093. */
export const OCTT_PRESET_QUIRKS = {
  csrKeyAlgorithm: "RSA",
  csrPemLineEndings: "crlf",
  requiredCertificateSignatureAlgorithms: ["RSASSA-PKCS1-v1_5"],
  hiddenConfigurationKeys: ["CpoName"],
} as const;

/** Valid certificate signature algorithm names for certQuirks validation. */
export const CERT_SIGNATURE_ALGORITHMS = [
  "ECDSA",
  "RSASSA-PKCS1-v1_5",
  "RSA-PSS",
] as const;
