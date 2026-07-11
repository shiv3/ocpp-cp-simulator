import { OCPPStatus, OCPPAvailability } from "../types/OcppTypes";

/**
 * ChargePoint event types
 */
export interface ChargePointEvents {
  // Status events
  statusChange: { status: OCPPStatus; message?: string };
  error: { error: string };

  // Connection events
  connected: void;
  disconnected: { code: number; reason: string };
  reconnecting: { attempt: number; maxAttempts: number };

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
   *  incoming actions without per-action wiring (issue #110). */
  incomingCallReceived: {
    action: string;
    payload: unknown;
  };
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
