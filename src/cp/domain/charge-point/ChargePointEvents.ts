import { OCPPStatus, OCPPAvailability } from "../types/OcppTypes";
import type { ActiveChargingProfile } from "../connector/Connector";

/** The CSMS's answer to BootNotification.req, as every OCPP version words it. */
export type RegistrationStatus = "Accepted" | "Pending" | "Rejected";

export interface BootNotificationResult {
  status: RegistrationStatus;
  interval: number;
  currentTime: string;
}

/** How the simulator answered an incoming CSMS CALL (#396). `NoResponse`
 *  means the CALL is left unanswered (an inbound `ignore` policy). */
export type IncomingCallCompletion =
  | {
      action: string;
      messageId?: string;
      outcome: "CallResult" | "NoResponse";
    }
  | {
      action: string;
      messageId?: string;
      outcome: "CallError";
      errorCode: string;
    };

/** A network-sim rule forcing a disconnect (#448). */
export interface NetworkFaultInjected {
  ruleId: string;
  ruleType: "manual-disconnect" | "periodic-disconnect";
  reconnectDelayMs: number;
}

/** What installed a charging profile (#469). RemoteStart profiles are
 *  ignored by the simulator, so the CSMS's SetChargingProfile is the only one. */
export type ChargingProfileSource = "SetChargingProfile";

/** Why charging profiles were removed (#469). */
export type ChargingProfileClearReason =
  | "ClearChargingProfile"
  | "TransactionEnded"
  | "ConnectionClosed"
  | "ConnectorRemoved";

/** Profiles removed from one scope: a connector, or the station store
 *  (`connectorId` 0). */
export interface ClearedChargingProfiles {
  connectorId: number;
  profiles: ActiveChargingProfile[];
}

/**
 * ChargePoint event types
 */
export interface ChargePointEvents {
  // Status events
  statusChange: {
    status: OCPPStatus;
    previousStatus: OCPPStatus;
    message?: string;
  };
  error: { error: string };

  // Connection events
  connected: void;
  /** Emitted once per processed BootNotification.conf, whatever the OCPP
   *  version or transport, after the boot gate took the new status and before
   *  any status transition the answer causes (#395). `connected` only means
   *  the socket opened; this is what says the CSMS registered the station. */
  bootNotificationResult: BootNotificationResult;
  disconnected: { code: number; reason: string };
  /** Emitted each time the transport schedules a reconnect after an
   *  unrequested close; `delayMs` is the wait before the next attempt. */
  reconnecting: { attempt: number; delayMs: number };
  /** Emitted when a network-sim disconnect rule fires, before the socket is
   *  closed, so the `disconnected` that follows can be attributed to it
   *  (#448). */
  networkFaultInjected: NetworkFaultInjected;

  // Connector events
  connectorStatusChange: {
    connectorId: number;
    status: OCPPStatus;
    previousStatus: OCPPStatus;
  };
  connectorAvailabilityChange: {
    connectorId: number;
    availability: OCPPAvailability;
  };
  connectorTransactionChange: {
    connectorId: number;
    transactionId: number | null;
  };
  connectorMeterValueChange: {
    connectorId: number;
    meterValue: number;
  };
  connectorSocChange: {
    connectorId: number;
    soc: number | null;
  };
  connectorRemoved: {
    connectorId: number;
  };

  // Smart-charging events (#469)
  /** A profile was installed on a connector or, with `connectorId` 0, on the
   *  station store. `replaced` is true when it updated a profile with the
   *  same id in that scope. */
  chargingProfileApplied: {
    connectorId: number;
    profile: ActiveChargingProfile;
    replaced: boolean;
    source: ChargingProfileSource;
  };
  /** At least one profile was removed from one scope. Never emitted for a
   *  clear that matched nothing, nor for a persistence restore. */
  chargingProfilesCleared: ClearedChargingProfiles & {
    reason: ChargingProfileClearReason;
  };

  // Transaction events
  remoteStartReceived: {
    connectorId: number;
    tagId: string;
    remoteStartId?: number;
  };
  /** Emitted when CSMS sends RemoteStopTransaction.req while a scenario
   *  has registered as the stop-side handler for this connector. The
   *  default handler delegates instead of calling stopTransaction itself,
   *  so it's up to the scenario's next node (typically Transaction Stop)
   *  to actually emit StopTransaction.req. */
  remoteStopReceived: {
    connectorId: number;
    transactionId: number;
  };
  /** Emitted for every CSMS-initiated CALL as it enters the dispatch
   *  layer, before (and regardless of) handler execution or a response
   *  override. Lets scenario csmsCallTrigger nodes park on arbitrary
   *  incoming actions without per-action wiring (issue #110). `messageId`
   *  is the CALL's UniqueId (#396) — the WS-Addressing MessageID on SOAP,
   *  which the envelope parser requires. Every transport sets it; it is
   *  optional only for callers outside the transports (tests). */
  incomingCallReceived: {
    action: string;
    payload: unknown;
    messageId?: string;
  };
  /** Emitted once the answer to an incoming CSMS CALL is decided, just
   *  before it is handed to the transport (#396): after the handler's
   *  synchronous work, before any post-response effect. It reports the
   *  answer chosen, not its delivery. */
  incomingCallCompleted: IncomingCallCompletion;
  transactionStarted: {
    connectorId: number;
    transactionId: number;
    tagId: string;
  };
  transactionStopped: {
    connectorId: number;
    transactionId: number;
    reason?: string;
  };
  /** Emitted by AuthorizeResultHandler whenever an Authorize.conf arrives,
   *  tagId-correlated via the original Authorize.req payload (issue #181).
   *  `ChargePoint.authorizeAndWait` listens for this to resolve the
   *  local-start authorize gate; scenarios/tests may also observe it. */
  authorizeResult: {
    tagId: string;
    status: string;
  };
  /** Emitted when a LOCAL transaction start is refused because
   *  Authorize.conf came back Invalid/Expired/Blocked (issue #181). The
   *  connector status is left untouched and no StartTransaction.req is
   *  sent. */
  authorizeDenied: {
    connectorId: number;
    tagId: string;
    status: string;
  };
  /** Emitted by StartTransactionResultHandler when StartTransaction.conf
   *  carries a non-Accepted idTagInfo.status (issue #181). `stopped`
   *  reflects whether `StopTransactionOnInvalidId` caused an automatic
   *  DeAuthorized stop (`true`) or the transaction was left running
   *  (`false`). */
  startTransactionNotAccepted: {
    connectorId: number;
    status: string;
    stopped: boolean;
  };
  /** Emitted when the CSMS answers StartTransaction.req with a CALLERROR
   *  (#447), once the connector's transaction is closed (its stop time and
   *  meter stamped): it never started on the CSMS side, and no
   *  StopTransaction.req follows. Listeners still find it on the connector;
   *  it is detached right after, so no stop path reaches it (#491). */
  transactionStartFailed: {
    connectorId: number;
    errorCode: string;
  };

  // Message events
  messageSent: {
    messageId: string;
    action: string;
    payload: unknown;
  };
  messageReceived: {
    messageId: string;
    action: string;
    payload: unknown;
  };

  // Heartbeat events
  heartbeatSent: void;
  heartbeatReceived: { currentTime: string };

  // Log events
  log: {
    timestamp: Date;
    level: number;
    type: string;
    message: string;
  };
}
